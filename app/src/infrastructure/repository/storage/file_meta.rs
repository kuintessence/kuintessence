use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use anyhow::anyhow;

use async_trait::async_trait;
use database_model::file_metadata;
use domain_storage::model::entity::FileMeta;
use domain_storage::model::vo::HashAlgorithm;
use domain_storage::repository::FileMetaRepo;
use sea_orm::prelude::*;
use sea_orm::Condition;
use sea_orm::QueryTrait;
use sea_orm::Set;
use std::sync::atomic::Ordering;

use crate::infrastructure::database::OrmRepo;

#[async_trait]
impl FileMetaRepo for OrmRepo {
    async fn get_by_hash_and_algorithm(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> anyhow::Result<Option<FileMeta>> {
        Ok(
            match file_metadata::Entity::find()
                .filter(
                    Condition::all()
                        .add(file_metadata::Column::Hash.eq(hash))
                        .add(file_metadata::Column::HashAlgorithm.eq(hash_algorithm.to_string())),
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
impl ReadOnlyRepository<FileMeta> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<FileMeta> {
        let model = file_metadata::Entity::find_by_id::<Uuid>(uuid)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow!("There is no such file_meta with, id: {uuid}"))?;
        Ok(model.try_into()?)
    }
}

#[async_trait::async_trait]
impl MutableRepository<FileMeta> for OrmRepo {
    async fn insert(&self, entity: &FileMeta) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let active_model = file_metadata::ActiveModel {
            id: Set(entity.id),
            name: Set(entity.name.to_owned()),
            hash: Set(entity.hash.to_owned()),
            hash_algorithm: Set(entity.hash_algorithm.to_string()),
            size: Set(entity.size as i64),
            ..Default::default()
        };
        let stmt = file_metadata::Entity::insert(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity.id)
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait::async_trait]
impl DBRepository<FileMeta> for OrmRepo {}
