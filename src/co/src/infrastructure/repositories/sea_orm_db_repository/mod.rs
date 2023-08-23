use alice_infrastructure::data::db::Database;
use derive_builder::Builder;
use sea_orm::{ConnectionTrait, Statement, TransactionTrait};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Mutex;
use uuid::Uuid;
mod cluster;
mod file_meta;
mod file_storage;
mod installed_software;
mod net_disk;
mod node_instance;
mod software_block_list;
mod storage_server;
mod workflow_draft;
mod workflow_instance;

#[derive(Builder)]
pub struct SeaOrmDbRepository {
    pub(self) db: Arc<Database>,
    #[builder(setter(skip), default = "Arc::new(Mutex::new(vec![]))")]
    pub(self) statements: Arc<Mutex<Vec<Statement>>>,
    #[builder(setter(skip), default = "AtomicBool::new(true)")]
    pub(self) can_drop: AtomicBool,
    pub(self) user_id: Option<String>,
}

impl SeaOrmDbRepository {
    pub(self) async fn save_changed(&self) -> anyhow::Result<bool> {
        if !self.can_drop.load(Ordering::Relaxed) {
            let mut stmts = self.statements.lock().await;
            let trans = self.db.get_connection().begin().await?;
            for stmt in stmts.iter() {
                if let Err(e) = trans.execute(stmt.clone()).await {
                    trans.rollback().await?;
                    stmts.clear();
                    self.can_drop.store(true, Ordering::Relaxed);
                    anyhow::bail!(e);
                }
            }
            trans.commit().await?;
            self.can_drop.store(true, Ordering::Relaxed);
            stmts.clear();
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub(self) fn user_id(&self, user_id: Option<Uuid>) -> anyhow::Result<Uuid> {
        user_id
            .or(self.user_id.to_owned().map(|el| Uuid::parse_str(&el)).transpose()?)
            .ok_or(anyhow::anyhow!("Seaorm repo no user id when need it."))
    }
}

impl Drop for SeaOrmDbRepository {
    fn drop(&mut self) {
        if !self.can_drop.load(Ordering::Relaxed) {
            log::trace!("{}", self.can_drop.load(Ordering::Relaxed));
            let stmts = self.statements.try_lock().unwrap();
            let sqls = stmts.iter().map(|x| x.to_string()).collect::<Vec<String>>().join("\n");
            log::trace!("Unused sql statements:\n{sqls}")
        }
    }
}
