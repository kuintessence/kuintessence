//! Queue resource service.

use async_trait::async_trait;
use uuid::Uuid;

use crate::model::{
    entity::{
        queue::{QueueCacheInfo, QueueResourceUsed},
        Queue,
    },
    vo::SchedulingStrategy,
};

#[async_trait]
/// Queue resource service.
pub trait QueueResourceService: Send + Sync {
    /// Get an available queue.
    async fn get_queue(
        &self,
        task_id: Uuid,
        scheduling_strategy: &SchedulingStrategy,
    ) -> anyhow::Result<Queue>;

    /// Add cached used queue resources.
    async fn add_used_queue_resources(&self, queue: &Queue) -> anyhow::Result<()>;

    /// Release cached used queue resources.
    async fn release_used_queue_resources(&self, queue_id: Uuid, resource_used: &QueueResourceUsed);

    /// Add new queue.
    async fn insert_queue(&self, queue: &Queue) -> anyhow::Result<()>;

    /// Update cached queue info when task started.
    async fn task_started(&self, queue_id: Uuid) -> anyhow::Result<()>;

    /// Set cached queue info to new value.
    async fn update_queue_resource(&self, queue_id: Uuid, queue: &QueueCacheInfo);

    /// Test if a queue is run out of resource, Err when is run out of resource.
    async fn test_queue_run_out_of_resource(&self, queue_id: Uuid) -> anyhow::Result<()>;

    /// Get queue cache info.
    async fn get_queue_cache_info(&self, queue_id: Uuid) -> anyhow::Result<QueueCacheInfo>;
}
