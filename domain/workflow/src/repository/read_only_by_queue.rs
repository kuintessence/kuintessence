use alice_architecture::{
    model::AggregateRoot,
    repository::{DBRepository, ReadOnlyRepository},
};
use async_trait::async_trait;
use uuid::Uuid;

#[async_trait]
pub trait ReadOnlyByQueueRepo<T>: ReadOnlyRepository<T>
where
    T: Send + AggregateRoot,
{
    async fn get_by_id_with_queue_id(&self, id: Uuid, queue_id: Uuid) -> anyhow::Result<T>;
}

pub trait DBByClusterRepo<T>: ReadOnlyByQueueRepo<T> + DBRepository<T> + Send + Sync
where
    T: Send + AggregateRoot,
{
}
