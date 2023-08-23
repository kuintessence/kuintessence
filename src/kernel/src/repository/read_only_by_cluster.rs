use crate::prelude::*;
use alice_architecture::{
    model::IAggregateRoot,
    repository::{IDBRepository, IReadOnlyRepository},
};

#[async_trait]
pub trait IReadOnlyByClusterRepository<T>: IReadOnlyRepository<T>
where
    T: std::marker::Send + IAggregateRoot,
{
    async fn get_by_id_with_cluster_id(&self, id: &str, cluster_id: &str) -> anyhow::Result<T>;
}

pub trait IDBByClusterRepository<T>: IReadOnlyByClusterRepository<T> + IDBRepository<T>
where
    T: std::marker::Send + IAggregateRoot,
{
}
