use std::sync::atomic::Ordering;

use crate::infrastructure::database::OrmRepo;
use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use anyhow::Context;
use database_model::task;
use domain_workflow::model::entity::task::{DbTask, Task};
use domain_workflow::model::entity::NodeInstance;
use domain_workflow::repository::TaskRepo;
use num_traits::FromPrimitive;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryTrait, Set};
use uuid::Uuid;

#[async_trait::async_trait]
impl DBRepository<Task> for OrmRepo {}

#[async_trait::async_trait]
impl MutableRepository<Task> for OrmRepo {
    async fn update(&self, entity: DbTask) -> anyhow::Result<()> {
        let mut stmts = self.statements.lock().await;
        let active_model = task::ActiveModel {
            status: entity.status.into(),
            node_instance_id: entity.node_instance_id.into_active_value(),
            body: entity.body.try_into()?,
            r#type: entity.r#type.into(),
            message: entity.message.into_active_value(),
            used_resources: entity.used_resources.try_into()?,
            ..Default::default()
        };
        let stmt = task::Entity::update(active_model)
            .filter(task::Column::Id.eq(*entity.id.value()?))
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    async fn insert_list(&self, entities: &[Task]) -> anyhow::Result<Vec<Uuid>> {
        let mut stmts = self.statements.lock().await;
        let f = |t: Task| -> anyhow::Result<task::ActiveModel> {
            Ok(task::ActiveModel {
                id: Set(t.id),
                node_instance_id: Set(t.node_instance_id),
                body: Set(serde_json::to_value(t.body)?),
                r#type: Set(t.r#type.to_owned() as i32),
                status: Set(t.status.to_owned() as i32),
                ..Default::default()
            })
        };
        let active_models: anyhow::Result<Vec<_>> = entities.iter().cloned().map(f).collect();
        let stmt = task::Entity::insert_many(active_models?)
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entities.iter().map(|e| e.id).collect::<Vec<_>>())
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait::async_trait]
impl ReadOnlyRepository<Task> for OrmRepo {}

#[async_trait::async_trait]
impl TaskRepo for OrmRepo {
    async fn get_same_node_tasks(&self, task_id: Uuid) -> anyhow::Result<Vec<Task>> {
        let task = (self as &dyn ReadOnlyRepository<Task>).get_by_id(task_id).await?;
        let node_instance_id = task.node_instance_id;
        self.get_tasks_by_node_id(node_instance_id).await
    }

    async fn get_tasks_by_node_id(&self, node_instance_id: Uuid) -> anyhow::Result<Vec<Task>> {
        let node = (self as &dyn ReadOnlyRepository<NodeInstance>)
            .get_by_id(node_instance_id)
            .await?;
        let queue_id = node
            .queue_id
            .with_context(|| format!("Node {node_instance_id} has no queue!"))?;
        let queue = (self as &dyn ReadOnlyRepository<domain_workflow::model::entity::Queue>)
            .get_by_id(queue_id)
            .await?;
        let queue_topic = queue.topic_name;
        task::Entity::find()
            .filter(task::Column::NodeInstanceId.eq(node_instance_id))
            .all(self.db.get_connection())
            .await?
            .into_iter()
            .map(|m| {
                let queue_topic = queue_topic.to_owned();
                Ok(Task {
                    id: m.id,
                    node_instance_id: m.node_instance_id,
                    r#type: FromPrimitive::from_i32(m.r#type).context("Invalid task type!")?,
                    body: m.body.to_string(),
                    status: FromPrimitive::from_i32(m.status).context("Invalid task status!")?,
                    message: m.message,
                    used_resources: m.used_resources.map(|u| u.to_string()),
                    queue_topic,
                })
            })
            .collect::<anyhow::Result<Vec<Task>>>()
    }
}
