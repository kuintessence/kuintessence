use alice_architecture::utils::*;
use alice_architecture::{
    model::IAggregateRoot,
    repository::{IDBRepository, IReadOnlyRepository},
};

#[async_trait]
pub trait ReadOnlyByQueueRepo<T>: IReadOnlyRepository<T> + Send + Sync
where
    T: Send + IAggregateRoot,
{
    async fn get_by_id_with_queue_id(&self, id: &str, queue_id: &str) -> anyhow::Result<T>;
}

pub trait DBByClusterRepo<T>: ReadOnlyByQueueRepo<T> + IDBRepository<T> + Send + Sync
where
    T: Send + IAggregateRoot,
{
}
