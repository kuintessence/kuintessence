use std::sync::atomic::Ordering;

use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use async_trait::async_trait;
use database_model::system::prelude::{QueueActiveModel, QueueColumn, QueueEntity};
use domain_workflow::model::entity::Queue;
use sea_orm::{prelude::*, sea_query::OnConflict, ConnectionTrait, QueryTrait, Set};

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<Queue> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<Queue> {
        let queue: Queue = QueueEntity::find_by_id(uuid)
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!("there is no such queue with key {uuid}"))?
            .into();
        Ok(queue)
    }

    async fn get_all(&self) -> anyhow::Result<Vec<Queue>> {
        QueueEntity::find()
            .all(self.db.get_connection())
            .await?
            .into_iter()
            .map(|m| Ok(m.into()))
            .collect()
    }
}

#[async_trait]
impl MutableRepository<Queue> for OrmRepo {
    /// 插入数据
    async fn insert(&self, entity: &Queue) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let entity2 = entity.to_owned();
        let stmt = QueueEntity::insert(QueueActiveModel {
            id: Set(entity2.id),
            name: Set(entity2.name),
            topic_name: Set(entity2.topic_name),
            memory: Set(entity2.memory),
            core_number: Set(entity2.core_number),
            storage_capacity: Set(entity2.storage_capacity),
            node_count: Set(entity2.node_count),
            scheduler_tech: Set(1),
            enabled: Set(entity2.enabled),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(QueueColumn::Id)
                .update_columns([
                    QueueColumn::Memory,
                    QueueColumn::CoreNumber,
                    QueueColumn::StorageCapacity,
                    QueueColumn::NodeCount,
                ])
                .to_owned(),
        )
        .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity.id)
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait]
impl DBRepository<Queue> for OrmRepo {}
