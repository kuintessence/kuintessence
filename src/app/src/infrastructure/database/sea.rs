use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use alice_infrastructure::data::db::Database;
use sea_orm::{ConnectionTrait, Statement, TransactionTrait};
use tokio::sync::Mutex;
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct SeaOrmDbRepository {
    pub db: Arc<Database>,
    #[builder(default)]
    pub statements: Arc<Mutex<Vec<Statement>>>,
    #[builder(default = AtomicBool::new(true))]
    pub can_drop: AtomicBool,
    pub user_id: Option<String>,
}

impl SeaOrmDbRepository {
    pub async fn save_changed(&self) -> anyhow::Result<bool> {
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

    pub fn user_id(&self, user_id: Option<Uuid>) -> anyhow::Result<Uuid> {
        user_id
            .or(self.user_id.to_owned().map(|el| Uuid::parse_str(&el)).transpose()?)
            .ok_or(anyhow::anyhow!("Seaorm repo no user id when need it."))
    }
}

impl Drop for SeaOrmDbRepository {
    fn drop(&mut self) {
        if !self.can_drop.load(Ordering::Relaxed) {
            tracing::trace!("{}", self.can_drop.load(Ordering::Relaxed));
            let stmts = self.statements.try_lock().unwrap();
            let sqls = stmts.iter().map(|x| x.to_string()).collect::<Vec<String>>().join("\n");
            tracing::trace!("Unused sql statements:\n{sqls}")
        }
    }
}
