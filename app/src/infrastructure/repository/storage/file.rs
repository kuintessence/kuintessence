use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use anyhow::anyhow;
use database_model::file_storage;
use std::sync::atomic::Ordering;

use domain_storage::model::entity::FileStorage;
use domain_storage::repository::FileStorageRepo;
use sea_orm::{
    ActiveValue::*, ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter, QueryTrait,
};
use uuid::Uuid;

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<FileStorage> for OrmRepo {}

#[async_trait::async_trait]
impl MutableRepository<FileStorage> for OrmRepo {
    async fn insert(&self, entity: &FileStorage) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let active_model = file_storage::ActiveModel {
            storage_server_id: Set(entity.storage_server_id),
            file_metadata_id: Set(entity.meta_id),
            server_url: Set(entity.server_url.to_owned()),
            created_user_id: Set(self.user_id()?),
            ..Default::default()
        };
        let stmt = file_storage::Entity::insert(active_model)
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
impl DBRepository<FileStorage> for OrmRepo {}

#[async_trait::async_trait]
impl FileStorageRepo for OrmRepo {
    async fn get_by_storage_server_id_and_meta_id(
        &self,
        storage_server_id: Uuid,
        meta_id: Uuid,
    ) -> anyhow::Result<String> {
        let x = file_storage::Entity::find()
            .filter(
                Condition::all()
                    .add(file_storage::Column::StorageServerId.eq(storage_server_id))
                    .add(file_storage::Column::FileMetadataId.eq(meta_id)), // .add(FileStorageColumn::CreatedUserId.eq(self.user_id(None)?)),
            )
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow!(format!(
                "No record with storage_server_id: {storage_server_id} and meta_id: {meta_id}."
            )))?;
        Ok(x.server_url)
    }
}
