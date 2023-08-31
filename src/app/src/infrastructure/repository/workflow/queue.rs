use std::str::FromStr;
use std::sync::atomic::Ordering;

use alice_architecture::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use async_trait::async_trait;
use database_model::system::prelude::{QueueActiveModel, QueueColumn, QueueEntity};
use domain_workflow::model::entity::Queue;
use sea_orm::{prelude::*, sea_query::OnConflict, ConnectionTrait, QueryTrait, Set};

use crate::infrastructure::database::SeaOrmDbRepository;

#[async_trait::async_trait]
impl IReadOnlyRepository<Queue> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<Queue> {
        let queue: Queue = QueueEntity::find_by_id(Uuid::from_str(uuid)?)
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
impl IMutableRepository<Queue> for SeaOrmDbRepository {
    /// 更新数据
    async fn update(&self, _entity: Queue) -> anyhow::Result<Queue> {
        unimplemented!()
    }

    /// 插入数据
    async fn insert(&self, entity: Queue) -> anyhow::Result<Queue> {
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
        Ok(entity)
    }

    /// 删除数据
    async fn delete(&self, _entity: Queue) -> anyhow::Result<bool> {
        unimplemented!()
    }

    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(&self, _uuid: &str, _entity: Option<Queue>) -> anyhow::Result<bool> {
        unimplemented!()
    }

    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait]
impl IDBRepository<Queue> for SeaOrmDbRepository {}
