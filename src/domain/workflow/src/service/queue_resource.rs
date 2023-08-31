use alice_architecture::utils::*;

use crate::model::entity::{
    queue::{QueueCacheInfo, QueueResourceUsed},
    Queue,
};

#[async_trait]
pub trait QueueResourceService: Send + Sync {
    /// Get an available queue.
    async fn get_queue(&self, task_id: Uuid) -> Anyhow<Queue>;

    /// Add cached used queue resources.
    async fn add_used_queue_resources(&self, queue: &Queue) -> Anyhow;

    /// Release cached used queue resources.
    async fn release_used_queue_resources(&self, queue_id: Uuid, resource_used: &QueueResourceUsed);

    /// Add new queue.
    async fn insert_queue(&self, queue: &Queue) -> Anyhow;

    /// Update cached queue info when task started.
    async fn task_started(&self, queue_id: Uuid) -> Anyhow;

    /// Set cached queue info to new value.
    async fn update_queue_resource(&self, queue_id: Uuid, queue: &QueueCacheInfo);

    async fn test_queue_run_out_of_resource(&self, queue_id: Uuid) -> Anyhow;

    async fn get_queue_cache_info(&self, queue_id: Uuid) -> Anyhow<QueueCacheInfo>;
}
