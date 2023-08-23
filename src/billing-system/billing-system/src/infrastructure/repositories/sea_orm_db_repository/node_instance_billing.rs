use super::SeaOrmDbRepository;
use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use billing_system_kernel::prelude::*;
use database_model::{
    sea_orm::{ConnectionTrait, EntityTrait, QueryTrait},
    system::prelude::*,
    utils::WithDecimalFileds,
};
use sea_orm::{prelude::Uuid, sea_query::OnConflict, ColumnTrait, QueryFilter};
use std::{str::FromStr, sync::atomic::Ordering};

#[async_trait::async_trait]
impl IReadOnlyRepository<NodeInstanceBilling> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<NodeInstanceBilling> {
        let mut entity = NodeInstanceBillingEntity::find_by_id(Uuid::from_str(uuid)?)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("there is no such row with key {uuid}"))?;
        entity.rescale_all_to(2);
        entity.try_into()
    }
    async fn get_all(&self) -> anyhow::Result<Vec<NodeInstanceBilling>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl IMutableRepository<NodeInstanceBilling> for SeaOrmDbRepository {
    async fn update(&self, entity: NodeInstanceBilling) -> anyhow::Result<NodeInstanceBilling> {
        let mut stmts = self.statements.lock().await;
        let active_model = NodeInstanceBillingModel::try_from(entity.to_owned())?.into_set();
        let stmt = NodeInstanceBillingEntity::update(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity)
    }
    async fn insert(&self, entity: NodeInstanceBilling) -> anyhow::Result<NodeInstanceBilling> {
        log::debug!("nb: {entity:#?}");
        NodeInstanceBillingEntity::insert(
            NodeInstanceBillingModel::try_from(entity.to_owned())?.into_set(),
        )
        .on_conflict(
            OnConflict::column(NodeInstanceBillingColumn::NodeInstanceId)
                .do_nothing()
                .to_owned(),
        )
        .exec(self.db.get_connection())
        .await?;
        Ok(entity)
    }
    async fn delete(&self, _entity: NodeInstanceBilling) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn delete_by_id(
        &self,
        _uuid: &str,
        _entity: Option<NodeInstanceBilling>,
    ) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

impl IDBRepository<NodeInstanceBilling> for SeaOrmDbRepository {}

#[async_trait::async_trait]
impl INodeInstanceBillingRepository for SeaOrmDbRepository {
    async fn get_all_by_flow_instance_id(
        &self,
        id: &str,
    ) -> anyhow::Result<Vec<NodeInstanceBilling>> {
        let res = NodeInstanceBillingEntity::find()
            .filter(NodeInstanceBillingColumn::FlowInstanceId.eq(Uuid::from_str(id)?))
            .all(self.db.get_connection())
            .await?;

        let mut r = vec![];
        for mut el in res.into_iter() {
            el.rescale_all_to(2);
            r.push(el.try_into()?);
        }
        Ok(r)
    }
}
