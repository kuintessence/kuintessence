use std::sync::atomic::Ordering;

use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};

use database_model::system::prelude::*;
use domain_workflow::{
    model::entity::{node_instance::NodeInstanceStatus, NodeInstance},
    repository::NodeInstanceRepo,
};
use sea_orm::prelude::*;
use sea_orm::QueryTrait;

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<NodeInstance> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<NodeInstance> {
        NodeInstanceEntity::find_by_id(uuid)
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
    async fn update(&self, entity: &NodeInstance) -> anyhow::Result<()> {
        let mut stmts = self.statements.lock().await;
        let stmt =
            NodeInstanceEntity::update(NodeInstanceModel::try_from(entity.to_owned())?.into_set())
                .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn insert(&self, entity: &NodeInstance) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let stmt =
            NodeInstanceEntity::insert(NodeInstanceModel::try_from(entity.to_owned())?.into_set())
                .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity.id)
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
        let res = NodeInstanceEntity::find()
            .filter(NodeInstanceColumn::BatchParentId.is_not_null())
            .filter(NodeInstanceColumn::BatchParentId.eq(batch_parent_id))
            .all(self.db.get_connection())
            .await?;
        let mut r = vec![];
        for el in res.into_iter() {
            r.push(el.try_into()?);
        }
        Ok(r)
    }

    async fn is_all_same_entryment_nodes_success(&self, node_id: Uuid) -> anyhow::Result<bool> {
        let res = NodeInstanceEntity::find()
            .filter(NodeInstanceColumn::Id.eq(node_id))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such node!"))?;
        let flow_instance_id = res.flow_instance_id;
        let res = NodeInstanceEntity::find()
            .filter(NodeInstanceColumn::FlowInstanceId.eq(flow_instance_id))
            .filter(NodeInstanceColumn::BatchParentId.is_null())
            .all(self.db.get_connection())
            .await?;

        Ok(res.iter().all(|el| {
            el.status.eq(&(NodeInstanceStatus::Finished as i32))
                || el.status.eq(&(NodeInstanceStatus::Standby as i32))
        }))
    }

    async fn get_all_workflow_instance_stand_by_nodes(
        &self,
        workflow_instance_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>> {
        let res = NodeInstanceEntity::find()
            .filter(NodeInstanceColumn::FlowInstanceId.eq(workflow_instance_id))
            .filter(NodeInstanceColumn::Status.eq(NodeInstanceStatus::Standby as i32))
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
        let res = NodeInstanceEntity::find()
            .filter(NodeInstanceColumn::FlowInstanceId.eq(workflow_instance_id))
            .all(self.db.get_connection())
            .await?;
        let mut r = vec![];
        for el in res.into_iter() {
            r.push(el.try_into()?);
        }
        Ok(r)
    }

    async fn get_nth_of_batch_tasks(&self, sub_node_id: Uuid) -> anyhow::Result<usize> {
        let batch_parent_id = NodeInstanceEntity::find()
            .filter(NodeInstanceColumn::Id.eq(sub_node_id))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("No such node!"))?
            .id;
        let sub_nodes = NodeInstanceEntity::find()
            .filter(NodeInstanceColumn::BatchParentId.eq(batch_parent_id))
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
}
