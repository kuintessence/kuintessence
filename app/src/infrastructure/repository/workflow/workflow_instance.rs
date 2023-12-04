use std::sync::atomic::Ordering;

use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};

use database_model::flow_instance;
use domain_workflow::{
    model::entity::{workflow_instance::DbWorkflowInstance, NodeInstance, WorkflowInstance},
    repository::WorkflowInstanceRepo,
};
use sea_orm::{prelude::*, Set};
use sea_orm::{Condition, QueryTrait};

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<WorkflowInstance> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<WorkflowInstance> {
        let entity = flow_instance::Entity::find_by_id(uuid)
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
    async fn update(&self, entity: DbWorkflowInstance) -> anyhow::Result<()> {
        let mut stmts = self.statements.lock().await;
        let active_model = flow_instance::ActiveModel {
            id: entity.id.into_active_value(),
            status: entity.status.into(),
            spec: entity.spec.try_into()?,
            last_modified_time: entity.last_modified_time.into_active_value(),
            name: entity.name.into_active_value(),
            description: entity.description.into_active_value(),
            logo: entity.logo.into_active_value(),
            user_id: entity.user_id.into_active_value(),
            ..Default::default()
        };
        let stmt = flow_instance::Entity::update(active_model)
            // .filter(flow_instance::Column::UserId.eq(self.user_id()?))
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn insert(&self, entity: &WorkflowInstance) -> anyhow::Result<Uuid> {
        let active_model = flow_instance::ActiveModel {
            id: Set(entity.id),
            name: Set(entity.name.to_owned()),
            description: Set(entity.description.to_owned()),
            logo: Set(entity.logo.to_owned()),
            status: Set(entity.status.to_owned() as i32),
            spec: Set(serde_json::to_value(entity.spec.to_owned())?),
            user_id: Set(self.user_id()?),
            ..Default::default()
        };
        flow_instance::Entity::insert(active_model)
            .exec(self.db.get_connection())
            .await?;
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

    async fn update_immediately_with_lock(&self, entity: DbWorkflowInstance) -> anyhow::Result<()> {
        let last_modified_time = entity.last_modified_time.value()?.to_owned();

        let active_model = flow_instance::ActiveModel {
            id: entity.id.into_active_value(),
            status: entity.status.into(),
            spec: entity.spec.try_into()?,
            last_modified_time: entity.last_modified_time.into_active_value(),
            name: entity.name.into_active_value(),
            description: entity.description.into_active_value(),
            logo: entity.logo.into_active_value(),
            user_id: entity.user_id.into_active_value(),
            ..Default::default()
        };
        let stmt = flow_instance::Entity::update(active_model)
            .filter(
                Condition::all()
                    .add(flow_instance::Column::LastModifiedTime.eq(last_modified_time)),
            )
            .build(self.db.get_connection().get_database_backend());
        let rows_affected = self.db.get_connection().execute(stmt).await?.rows_affected();
        if rows_affected == 0 {
            anyhow::bail!("No rows affected when update workflow instance.")
        }
        Ok(())
    }
}
