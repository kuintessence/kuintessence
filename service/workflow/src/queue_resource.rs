use std::sync::Arc;

use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use alice_architecture::repository::DBRepository;
use anyhow::bail;
use async_trait::async_trait;
use domain_workflow::{
    model::entity::{
        queue::{QueueCacheInfo, QueueResourceUsed},
        task::{TaskResult, TaskResultStatus},
        Queue,
    },
    service::QueueResourceService,
};
use rand::Rng;
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct QueueResourceServiceImpl {
    queue_resource_repo: Arc<dyn DBRepository<Queue> >,
    message_producer: Arc<dyn MessageQueueProducerTemplate<TaskResult> >,
}

#[async_trait]
impl QueueResourceService for QueueResourceServiceImpl {
    async fn get_queue(&self, task_id: Uuid) -> anyhow::Result<Queue> {
        let queues = self.queue_resource_repo.get_all().await?;
        let mut not_full_queues = vec![];
        for queue in queues {
            if Queue::is_resource_full(&queue).await.is_ok() && queue.enabled {
                not_full_queues.push(queue);
            }
        }
        if not_full_queues.is_empty() {
            let task_result = TaskResult {
                id: task_id,
                status: TaskResultStatus::Failed,
                message: "no queue available".to_string(),
                used_resources: None,
            };
            self.message_producer.send_object(&task_result, Some("node_status")).await?;
            bail!("no queue available");
        }
        let mut rng = rand::thread_rng();
        let index = rng.gen_range(0..not_full_queues.len());
        Ok(not_full_queues[index].clone())
    }

    async fn add_used_queue_resources(&self, queue: &Queue) -> anyhow::Result<()> {
        Queue::cache_resource(queue).await
    }

    async fn release_used_queue_resources(
        &self,
        queue_id: Uuid,
        resource_used: &QueueResourceUsed,
    ) {
        Queue::release_resource(queue_id, resource_used).await;
    }

    async fn insert_queue(&self, queue: &Queue) -> anyhow::Result<()> {
        self.queue_resource_repo.insert(queue).await?;
        self.queue_resource_repo.save_changed().await?;
        Ok(())
    }

    async fn task_started(&self, queue_id: Uuid) -> anyhow::Result<()> {
        let queue = self.queue_resource_repo.get_by_id(queue_id).await?;
        Queue::task_started(&queue).await
    }

    async fn update_queue_resource(&self, queue_id: Uuid, info: &QueueCacheInfo) {
        Queue::update_resource(queue_id, info).await
    }

    async fn test_queue_run_out_of_resource(&self, queue_id: Uuid) -> anyhow::Result<()> {
        let queue = self.queue_resource_repo.get_by_id(queue_id).await?;
        Queue::is_resource_full(&queue).await
    }

    async fn get_queue_cache_info(&self, queue_id: Uuid) -> anyhow::Result<QueueCacheInfo> {
        Queue::get_cache_info(queue_id).await
    }
}
