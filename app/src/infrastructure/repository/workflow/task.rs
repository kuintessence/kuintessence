use std::sync::atomic::Ordering;

use crate::infrastructure::database::OrmRepo;
use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use database_model::{node_instance, task};
use domain_workflow::model::entity::task::Task;
use domain_workflow::repository::TaskRepo;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryTrait, Set};
use uuid::Uuid;

#[async_trait::async_trait]
impl DBRepository<Task> for OrmRepo {}

#[async_trait::async_trait]
impl MutableRepository<Task> for OrmRepo {
    async fn update(&self, entity: &Task) -> anyhow::Result<()> {
        let mut stmts = self.statements.lock().await;
        let active_model = task::ActiveModel {
            status: Set(entity.status.to_owned() as i32),
            ..Default::default()
        };
        let stmt = task::Entity::update(active_model)
            .filter(task::Column::Id.eq(entity.id))
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    async fn insert_list(&self, entities: &[&Task]) -> anyhow::Result<Vec<String>> {
        let mut stmts = self.statements.lock().await;
        let f = |t: Task| -> anyhow::Result<task::ActiveModel> {
            Ok(task::ActiveModel {
                id: Set(t.id),
                node_instance_id: Set(t.node_instance_id),
                body: Set(serde_json::to_value(t.body)?),
                r#type: Set(t.r#type.to_owned() as i32),
                status: Set(t.status.to_owned() as i32),
            })
        };
        let active_models: anyhow::Result<Vec<_>> =
            entities.iter().cloned().cloned().map(f).collect();
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
    async fn get_same_node_tasks(&self, node_instance_id: String) -> anyhow::Result<Vec<Task>> {
        task::Entity::find()
            .filter(task::Column::NodeInstanceId.eq(node_instance_id))
            .all(self.db.get_connection())
            .await?
            .into_iter()
            .map(|m| m.try_into())
            .collect::<anyhow::Result<Vec<Task>>>()
    }
}
