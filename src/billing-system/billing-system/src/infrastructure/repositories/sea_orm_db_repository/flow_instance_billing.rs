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
impl IReadOnlyRepository<FlowInstanceBilling> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<FlowInstanceBilling> {
        let mut entity = FlowInstanceBillingEntity::find_by_id(Uuid::from_str(uuid)?)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("there is no such row with key {uuid}"))?;
        entity.rescale_all_to(2);
        entity.try_into()
    }
    async fn get_all(&self) -> anyhow::Result<Vec<FlowInstanceBilling>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl IMutableRepository<FlowInstanceBilling> for SeaOrmDbRepository {
    async fn update(&self, entity: FlowInstanceBilling) -> anyhow::Result<FlowInstanceBilling> {
        let mut stmts = self.statements.lock().await;
        let active_model = FlowInstanceBillingModel::try_from(entity.to_owned())?.into_set();
        let stmt = FlowInstanceBillingEntity::update(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity)
    }
    async fn insert(&self, entity: FlowInstanceBilling) -> anyhow::Result<FlowInstanceBilling> {
        FlowInstanceBillingEntity::insert(
            FlowInstanceBillingModel::try_from(entity.to_owned())?.into_set(),
        )
        .on_conflict(
            OnConflict::column(FlowInstanceBillingColumn::FlowInstanceId)
                .do_nothing()
                .to_owned(),
        )
        .exec(self.db.get_connection())
        .await?;
        Ok(entity)
    }
    async fn delete(&self, _entity: FlowInstanceBilling) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn delete_by_id(
        &self,
        _uuid: &str,
        _entity: Option<FlowInstanceBilling>,
    ) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

impl IDBRepository<FlowInstanceBilling> for SeaOrmDbRepository {}

#[async_trait::async_trait]
impl IFlowInstanceBillingRepository for SeaOrmDbRepository {
    async fn get_by_flow_instance_id(&self, id: &str) -> anyhow::Result<FlowInstanceBilling> {
        let mut model = FlowInstanceBillingEntity::find()
            .filter(FlowInstanceBillingColumn::FlowInstanceId.eq(Uuid::from_str(id)?))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such Flow Instence"))?;
        model.rescale_all_to(2);
        model.try_into()
    }
    async fn insert_or_update(&self, entity: FlowInstanceBilling) -> anyhow::Result<()> {
        let mut stmts = self.statements.lock().await;
        let active_model = FlowInstanceBillingModel::try_from(entity.to_owned())?.into_set();
        let stmt = FlowInstanceBillingEntity::insert(active_model)
            .on_conflict(
                OnConflict::column(FlowInstanceBillingColumn::Id)
                    .update_columns([
                        FlowInstanceBillingColumn::Cpu,
                        FlowInstanceBillingColumn::CpuTime,
                        FlowInstanceBillingColumn::Memory,
                        FlowInstanceBillingColumn::Storage,
                        FlowInstanceBillingColumn::TotalPrice,
                        FlowInstanceBillingColumn::WallTime,
                    ])
                    .to_owned(),
            )
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(())
    }
}
