use std::sync::atomic::Ordering;

use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};

use database_model::node_instance;
use domain_workflow::{
    model::entity::{
        node_instance::{DbNodeInstance, NodeInstanceStatus},
        workflow_instance::NodeSpec,
        NodeInstance, WorkflowInstance,
    },
    repository::NodeInstanceRepo,
};
use sea_orm::QueryTrait;
use sea_orm::{prelude::*, Set};

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<NodeInstance> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<NodeInstance> {
        node_instance::Entity::find_by_id(uuid)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!(
                "There is no such node_instance with id: {uuid}"
            ))?
            .try_into()
    }

    async fn get_all(&self) -> anyhow::Result<Vec<NodeInstance>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl MutableRepository<NodeInstance> for OrmRepo {
    async fn update(&self, entity: DbNodeInstance) -> anyhow::Result<()> {
        let mut stmts = self.statements.lock().await;
        let active_model = node_instance::ActiveModel {
            id: entity.id.into_active_value(),
            status: entity.status.into(),
            resource_meter: entity.resource_meter.try_into()?,
            log: entity.log.into_active_value(),
            queue_id: entity.queue_id.into_active_value(),
            name: entity.name.into_active_value(),
            kind: entity.kind.into(),
            is_parent: entity.is_parent.into_active_value(),
            batch_parent_id: entity.batch_parent_id.into_active_value(),
            flow_instance_id: entity.flow_instance_id.into_active_value(),
            ..Default::default()
        };
        let stmt = node_instance::Entity::update(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn insert(&self, entity: &NodeInstance) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let active_model = node_instance::ActiveModel {
            id: Set(entity.id),
            name: Set(entity.name.to_owned()),
            kind: Set(entity.kind.to_owned() as i32),
            is_parent: Set(entity.is_parent),
            batch_parent_id: Set(entity.batch_parent_id),
            status: Set(entity.status.to_owned() as i32),
            resource_meter: Set(entity
                .resource_meter
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?),
            log: Set(entity.log.to_owned()),
            queue_id: Set(entity.queue_id),
            flow_instance_id: Set(entity.flow_instance_id),
            ..Default::default()
        };
        let stmt = node_instance::Entity::insert(active_model)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity.id)
    }

    async fn insert_list(&self, entities: &[NodeInstance]) -> anyhow::Result<Vec<Uuid>> {
        let mut stmts = self.statements.lock().await;
        let f = |n: NodeInstance| -> anyhow::Result<node_instance::ActiveModel> {
            Ok(node_instance::ActiveModel {
                id: Set(n.id),
                name: Set(n.name.to_owned()),
                kind: Set(n.kind.to_owned() as i32),
                is_parent: Set(n.is_parent),
                batch_parent_id: Set(n.batch_parent_id),
                status: Set(n.status.to_owned() as i32),
                resource_meter: Set(n
                    .resource_meter
                    .as_ref()
                    .map(serde_json::to_value)
                    .transpose()?),
                log: Set(n.log.to_owned()),
                queue_id: Set(n.queue_id),
                flow_instance_id: Set(n.flow_instance_id),
                ..Default::default()
            })
        };
        let active_models: anyhow::Result<Vec<_>> = entities.iter().cloned().map(f).collect();
        let stmt = node_instance::Entity::insert_many(active_models?)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entities.iter().map(|e| e.id).collect())
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

impl DBRepository<NodeInstance> for OrmRepo {}

#[async_trait::async_trait]
impl NodeInstanceRepo for OrmRepo {
    async fn get_node_sub_node_instances(
        &self,
        batch_parent_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>> {
        let res = node_instance::Entity::find()
            .filter(node_instance::Column::BatchParentId.is_not_null())
            .filter(node_instance::Column::BatchParentId.eq(batch_parent_id))
            .all(self.db.get_connection())
            .await?;
        let mut r = vec![];
        for el in res.into_iter() {
            r.push(el.try_into()?);
        }
        Ok(r)
    }

    async fn is_all_same_entryment_nodes_success(&self, node_id: Uuid) -> anyhow::Result<bool> {
        let res = node_instance::Entity::find()
            .filter(node_instance::Column::Id.eq(node_id))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such node!"))?;
        let flow_instance_id = res.flow_instance_id;
        let res = node_instance::Entity::find()
            .filter(node_instance::Column::FlowInstanceId.eq(flow_instance_id))
            .filter(node_instance::Column::BatchParentId.is_null())
            .all(self.db.get_connection())
            .await?;

        Ok(res.iter().all(|el| {
            el.status.eq(&(NodeInstanceStatus::Completed as i32))
                || el.status.eq(&(NodeInstanceStatus::Standby as i32))
        }))
    }

    async fn get_all_workflow_instance_stand_by_nodes(
        &self,
        workflow_instance_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>> {
        let res = node_instance::Entity::find()
            .filter(node_instance::Column::FlowInstanceId.eq(workflow_instance_id))
            .filter(node_instance::Column::Status.eq(NodeInstanceStatus::Standby as i32))
            .all(self.db.get_connection())
            .await?;
        let mut r = vec![];
        for el in res.into_iter() {
            r.push(el.try_into()?);
        }
        Ok(r)
    }

    async fn get_all_workflow_instance_nodes(
        &self,
        workflow_instance_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>> {
        let res = node_instance::Entity::find()
            .filter(node_instance::Column::FlowInstanceId.eq(workflow_instance_id))
            .all(self.db.get_connection())
            .await?;
        let mut r = vec![];
        for el in res.into_iter() {
            r.push(el.try_into()?);
        }
        Ok(r)
    }

    async fn get_nth_of_batch_tasks(&self, sub_node_id: Uuid) -> anyhow::Result<usize> {
        let batch_parent_id = node_instance::Entity::find()
            .filter(node_instance::Column::Id.eq(sub_node_id))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such node!"))?
            .id;
        let sub_nodes = node_instance::Entity::find()
            .filter(node_instance::Column::BatchParentId.eq(batch_parent_id))
            .all(self.db.get_connection())
            .await?;
        let mut nth = None;
        for (i, sub_node) in sub_nodes.iter().enumerate() {
            if sub_node.id.eq(&sub_node_id) {
                nth = Some(i)
            }
        }
        Ok(nth.ok_or(anyhow::anyhow!("No such sub node!"))?)
    }

    async fn get_node_spec(&self, node_id: Uuid) -> anyhow::Result<NodeSpec> {
        let node = (self as &dyn ReadOnlyRepository<NodeInstance>).get_by_id(node_id).await?;
        let flow_id = node.flow_instance_id;
        let flow = (self as &dyn ReadOnlyRepository<WorkflowInstance>).get_by_id(flow_id).await?;
        let node_spec = flow
            .spec
            .node_specs
            .iter()
            .find(|n| n.id.eq(&node_id))
            .cloned()
            .ok_or(anyhow::anyhow!("No such node spec!"))?;
        Ok(node_spec)
    }
}
