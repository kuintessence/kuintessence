use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use anyhow::anyhow;
use std::sync::atomic::Ordering;

use database_model::system::prelude::*;
use domain_storage::model::entity::FileStorage;
use domain_storage::repository::FileStorageRepo;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter, QueryTrait};
use uuid::Uuid;

use crate::infrastructure::database::SeaOrmDbRepository;

#[async_trait::async_trait]
impl ReadOnlyRepository<FileStorage> for SeaOrmDbRepository {}

#[async_trait::async_trait]
impl MutableRepository<FileStorage> for SeaOrmDbRepository {
    async fn insert(&self, entity: &FileStorage) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let mut model = FileStorageModel::try_from(entity.to_owned())?;
        model.created_user_id = self.user_id()?;
        let active_model = model.into_set();
        let stmt = FileStorageEntity::insert(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity.meta_id)
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait::async_trait]
impl DBRepository<FileStorage> for SeaOrmDbRepository {}

#[async_trait::async_trait]
impl FileStorageRepo for SeaOrmDbRepository {
    async fn get_by_storage_server_id_and_meta_id(
        &self,
        storage_server_id: Uuid,
        meta_id: Uuid,
    ) -> anyhow::Result<String> {
        let x = FileStorageEntity::find()
            .filter(
                Condition::all()
                    .add(FileStorageColumn::StorageServerId.eq(storage_server_id))
                    .add(FileStorageColumn::FileMetadataId.eq(meta_id)), // .add(FileStorageColumn::CreatedUserId.eq(self.user_id(None)?)),
            )
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow!(format!(
                "No record with storage_server_id: {storage_server_id} and meta_id: {meta_id}."
            )))?;
        Ok(x.server_url)
    }
}
