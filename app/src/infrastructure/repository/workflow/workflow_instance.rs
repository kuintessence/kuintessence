use std::sync::atomic::Ordering;

use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};

use database_model::system::prelude::*;
use domain_workflow::{
    model::entity::{NodeInstance, WorkflowInstance},
    repository::WorkflowInstanceRepo,
};
use sea_orm::prelude::*;
use sea_orm::ActiveValue;
use sea_orm::QueryTrait;

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<WorkflowInstance> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<WorkflowInstance> {
        let entity = FlowInstanceEntity::find_by_id(uuid)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("There is no such flow_instance id: {uuid}",))?;
        entity.try_into()
    }

    async fn get_all(&self) -> anyhow::Result<Vec<WorkflowInstance>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl MutableRepository<WorkflowInstance> for OrmRepo {
    async fn update(&self, entity: &WorkflowInstance) -> anyhow::Result<()> {
        let mut stmts = self.statements.lock().await;
        let model = FlowInstanceModel::try_from(entity.to_owned())?;
        let mut active_model: FlowInstanceActiveModel = model.into();
        active_model.spec.reset();
        active_model.status.reset();
        let stmt = FlowInstanceEntity::update(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn insert(&self, entity: &WorkflowInstance) -> anyhow::Result<Uuid> {
        let mut model = FlowInstanceModel::try_from(entity.to_owned())?;
        model.user_id = self.user_id()?;
        let active_model: FlowInstanceActiveModel = model.into();
        let mut active_model = active_model.reset_all();
        active_model.created_time = ActiveValue::NotSet;
        active_model.last_modified_time = ActiveValue::NotSet;
        FlowInstanceEntity::insert(active_model).exec(self.db.get_connection()).await?;
        Ok(entity.id)
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

impl DBRepository<WorkflowInstance> for OrmRepo {}

#[async_trait::async_trait]
impl WorkflowInstanceRepo for OrmRepo {
    async fn get_by_node_id(&self, node_id: Uuid) -> anyhow::Result<WorkflowInstance> {
        let workflow_instance_id = ReadOnlyRepository::<NodeInstance>::get_by_id(self, node_id)
            .await?
            .flow_instance_id;

        Ok(ReadOnlyRepository::<WorkflowInstance>::get_by_id(self, workflow_instance_id).await?)
    }

    async fn update_immediately_with_lock(
        &self,
        entity: WorkflowInstance,
    ) -> anyhow::Result<WorkflowInstance> {
        let model = FlowInstanceModel::try_from(entity.to_owned())?;
        let mut active_model: FlowInstanceActiveModel = model.into();
        active_model.spec.reset();
        active_model.status.reset();
        let stmt = FlowInstanceEntity::update(active_model)
            .filter(FlowInstanceColumn::LastModifiedTime.eq(entity.last_modified_time))
            .build(self.db.get_connection().get_database_backend());
        let rows_affected = self.db.get_connection().execute(stmt).await?.rows_affected();
        if rows_affected == 0 {
            anyhow::bail!("No rows affected when update workflow instance.")
        }
        Ok(entity)
    }
}
