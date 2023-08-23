use super::SeaOrmDbRepository;
use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use database_model::system::prelude::*;
use kernel::prelude::*;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter,
    QueryTrait,
};
use std::{str::FromStr, sync::atomic::Ordering};

#[async_trait::async_trait]
impl IReadOnlyRepository<WorkflowInstance> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WorkflowInstance> {
        let entity = FlowInstanceEntity::find_by_id(Uuid::from_str(uuid)?)
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
impl IMutableRepository<WorkflowInstance> for SeaOrmDbRepository {
    async fn update(&self, entity: WorkflowInstance) -> anyhow::Result<WorkflowInstance> {
        let mut stmts = self.statements.lock().await;
        let model = FlowInstanceModel::try_from(entity.to_owned())?;
        let mut active_model: FlowInstanceActiveModel = model.into();
        active_model.spec.reset();
        active_model.status.reset();
        let stmt = FlowInstanceEntity::update(active_model)
            .filter(FlowInstanceColumn::LastModifiedTime.eq(entity.last_modified_time))
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity)
    }
    async fn insert(&self, entity: WorkflowInstance) -> anyhow::Result<WorkflowInstance> {
        let mut model = FlowInstanceModel::try_from(entity.to_owned())?;
        model.user_id = self.user_id(None)?;
        let active_model: FlowInstanceActiveModel = model.into();
        let mut active_model = active_model.reset_all();
        active_model.created_time = NotSet;
        active_model.last_modified_time = NotSet;
        FlowInstanceEntity::insert(active_model).exec(self.db.get_connection()).await?;
        Ok(entity)
    }
    async fn delete(&self, _entity: WorkflowInstance) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn delete_by_id(
        &self,
        _uuid: &str,
        _entity: Option<WorkflowInstance>,
    ) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

impl IDBRepository<WorkflowInstance> for SeaOrmDbRepository {}

#[async_trait::async_trait]
impl IWorkflowInstanceRepository for SeaOrmDbRepository {
    async fn get_by_node_id(&self, node_id: Uuid) -> anyhow::Result<WorkflowInstance> {
        let workflow_instance_id =
            IReadOnlyRepository::<NodeInstance>::get_by_id(self, &node_id.to_string())
                .await?
                .flow_instance_id;

        Ok(IReadOnlyRepository::<WorkflowInstance>::get_by_id(
            self,
            &workflow_instance_id.to_string(),
        )
        .await?)
    }
    async fn update_node_instance_prepared_file_ids(
        &self,
        old_id: Uuid,
        new_id: Uuid,
        node_instance_id: Uuid,
    ) -> Anyhow {
        let entity = self.get_by_node_id(node_instance_id).await?;
        let entity_str = serde_json::to_string(&entity)?;
        let entity_str = entity_str.replace(&old_id.to_string(), &new_id.to_string());
        let entity = serde_json::from_str::<WorkflowInstance>(&entity_str)?;
        self.update(entity).await?;
        Ok(())
    }
}
