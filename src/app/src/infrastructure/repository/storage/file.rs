use std::sync::atomic::Ordering;

use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use alice_architecture::utils::*;
use database_model::system::prelude::*;
use domain_storage::model::entity::FileStorage;
use domain_storage::repository::FileStorageRepo;
use sea_orm::{ColumnTrait, Condition, ConnectionTrait, EntityTrait, QueryFilter, QueryTrait};

use crate::infrastructure::database::SeaOrmDbRepository;

#[async_trait::async_trait]
impl IReadOnlyRepository<FileStorage> for SeaOrmDbRepository {
    async fn get_by_id(&self, _uuid: &str) -> anyhow::Result<FileStorage> {
        unimplemented!();
    }
    async fn get_all(&self) -> anyhow::Result<Vec<FileStorage>> {
        unimplemented!();
    }
}

#[async_trait::async_trait]
impl IMutableRepository<FileStorage> for SeaOrmDbRepository {
    async fn update(&self, _entity: FileStorage) -> anyhow::Result<FileStorage> {
        unimplemented!();
    }

    async fn insert(&self, entity: FileStorage) -> anyhow::Result<FileStorage> {
        let mut stmts = self.statements.lock().await;
        let mut model = FileStorageModel::try_from(entity.to_owned())?;
        model.created_user_id = self.user_id(None)?;
        let active_model = model.into_set();
        let stmt = FileStorageEntity::insert(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity)
    }

    async fn delete(&self, _entity: FileStorage) -> anyhow::Result<bool> {
        unimplemented!();
    }

    async fn delete_by_id(
        &self,
        _uuid: &str,
        _entity: Option<FileStorage>,
    ) -> anyhow::Result<bool> {
        unimplemented!();
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait::async_trait]
impl IDBRepository<FileStorage> for SeaOrmDbRepository {}

#[async_trait::async_trait]
impl FileStorageRepo for SeaOrmDbRepository {
    async fn get_all_by_meta_id(&self, meta_id: Uuid) -> anyhow::Result<Vec<FileStorage>> {
        Ok(FileStorageEntity::find()
            .filter(
                Condition::all().add(FileStorageColumn::FileMetadataId.eq(meta_id)), // .add(FileStorageColumn::CreatedUserId.eq(self.user_id(None)?)),
            )
            .all(self.db.get_connection())
            .await?
            .into_iter()
            .map(|el| el.into())
            .collect())
    }

    async fn insert_with_custom_user_id(&self, entity: FileStorage, user_id: Uuid) -> Anyhow {
        let mut stmts = self.statements.lock().await;
        let mut model = FileStorageModel::try_from(entity.to_owned())?;
        model.created_user_id = user_id;
        let active_model = model.into_set();
        let stmt = FileStorageEntity::insert(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn get_by_storage_server_id_and_meta_id(
        &self,
        storage_server_id: Uuid,
        meta_id: Uuid,
    ) -> Anyhow<String> {
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
