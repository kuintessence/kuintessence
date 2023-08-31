use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use alice_architecture::utils::*;
use database_model::system::prelude::*;
use domain_storage::model::entity::FileMeta;
use domain_storage::model::vo::HashAlgorithm;
use domain_storage::repository::FileMetaRepo;
use sea_orm::prelude::*;
use sea_orm::Condition;
use sea_orm::QueryTrait;
use std::sync::atomic::Ordering;

use crate::infrastructure::database::SeaOrmDbRepository;

#[async_trait]
impl FileMetaRepo for SeaOrmDbRepository {
    async fn get_by_hash_and_algorithm(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> anyhow::Result<Option<FileMeta>> {
        Ok(
            match FileMetadataEntity::find()
                .filter(
                    Condition::all()
                        .add(FileMetadataColumn::Hash.eq(hash))
                        .add(FileMetadataColumn::HashAlgorithm.eq(hash_algorithm.to_string())),
                )
                .one(self.db.get_connection())
                .await?
            {
                Some(el) => Some(el.try_into()?),
                None => None,
            },
        )
    }
}

#[async_trait::async_trait]
impl IReadOnlyRepository<FileMeta> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<FileMeta> {
        let model = FileMetadataEntity::find_by_id::<Uuid>(uuid.parse()?)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow!("There is no such file_meta with, id: {uuid}"))?;
        Ok(model.try_into()?)
    }

    async fn get_all(&self) -> anyhow::Result<Vec<FileMeta>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl IMutableRepository<FileMeta> for SeaOrmDbRepository {
    async fn update(&self, _entity: FileMeta) -> anyhow::Result<FileMeta> {
        unimplemented!();
    }

    async fn insert(&self, entity: FileMeta) -> anyhow::Result<FileMeta> {
        let mut stmts = self.statements.lock().await;
        let active_model = FileMetadataModel::try_from(entity.to_owned())?.into_set();
        let stmt = FileMetadataEntity::insert(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity)
    }

    async fn delete(&self, _entity: FileMeta) -> anyhow::Result<bool> {
        unimplemented!();
    }

    async fn delete_by_id(&self, _uuid: &str, _entity: Option<FileMeta>) -> anyhow::Result<bool> {
        unimplemented!();
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait::async_trait]
impl IDBRepository<FileMeta> for SeaOrmDbRepository {}
