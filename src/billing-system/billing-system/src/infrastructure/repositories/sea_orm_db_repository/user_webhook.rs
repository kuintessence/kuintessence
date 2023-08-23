use super::SeaOrmDbRepository;
use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use billing_system_kernel::prelude::*;
use database_model::{
    sea_orm::{ConnectionTrait, EntityTrait, QueryTrait},
    system::prelude::*,
};
use sea_orm::{sea_query::OnConflict, ColumnTrait, QueryFilter};
use std::{str::FromStr, sync::atomic::Ordering};
use uuid::Uuid;

#[async_trait::async_trait]
impl IReadOnlyRepository<UserWebhook> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<UserWebhook> {
        let entity = UserWebhookEntity::find()
            .filter(UserWebhookColumn::UserId.eq(Uuid::from_str(uuid)?))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("there is no such row with key {uuid}"))?;
        entity.try_into()
    }
    async fn get_all(&self) -> anyhow::Result<Vec<UserWebhook>> {
        unimplemented!()
    }
}
#[async_trait::async_trait]
impl IMutableRepository<UserWebhook> for SeaOrmDbRepository {
    async fn update(&self, entity: UserWebhook) -> anyhow::Result<UserWebhook> {
        let mut stmts = self.statements.lock().await;
        let active_model = UserWebhookModel::try_from(entity.to_owned())?.into_set();
        let stmt = UserWebhookEntity::update(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity)
    }
    async fn insert(&self, entity: UserWebhook) -> anyhow::Result<UserWebhook> {
        UserWebhookEntity::insert(UserWebhookModel::try_from(entity.to_owned())?.into_set())
            .on_conflict(
                OnConflict::column(UserWebhookColumn::UserId)
                    .update_column(UserWebhookColumn::Url)
                    .to_owned(),
            )
            .exec(self.db.get_connection())
            .await?;
        Ok(entity)
    }
    async fn delete(&self, _entity: UserWebhook) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn delete_by_id(
        &self,
        _uuid: &str,
        _entity: Option<UserWebhook>,
    ) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}
impl IDBRepository<UserWebhook> for SeaOrmDbRepository {}
#[async_trait::async_trait]
impl IUserWebhookRepository for SeaOrmDbRepository {
    async fn get_url_by_user_id(&self, id: &str) -> anyhow::Result<String> {
        let model = UserWebhookEntity::find()
            .filter(UserWebhookColumn::UserId.eq(Uuid::from_str(id)?))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such subscribe"))?;
        Ok(model.url)
    }
}
