use std::sync::Arc;

use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use alice_architecture::repository::DBRepository;
use anyhow::{bail, Context};
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{
            queue::{QueueCacheInfo, QueueResourceUsed},
            Queue,
        },
        vo::{
            msg::{ChangeMsg, Info, TaskChangeInfo, TaskStatusChange},
            SchedulingStrategy,
        },
    },
    service::QueueResourceService,
};
use rand::{seq::SliceRandom, thread_rng};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct QueueResourceServiceImpl {
    queue_resource_repo: Arc<dyn DBRepository<Queue>>,
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
}

impl QueueResourceServiceImpl {
    async fn get_all_quques(&self) -> anyhow::Result<Vec<Queue>> {
        let mut queues = self.queue_resource_repo.get_all().await?;
        let mut rng = thread_rng();
        queues.shuffle(&mut rng);
        Ok(queues)
    }
}

#[async_trait]
impl QueueResourceService for QueueResourceServiceImpl {
    async fn get_queue(
        &self,
        task_id: Uuid,
        scheduling_strategy: &SchedulingStrategy,
    ) -> anyhow::Result<Queue> {
        let mut result_queues = vec![];
        match scheduling_strategy {
            SchedulingStrategy::Manual { queues } => {
                for queue in queues {
                    let queue = self.queue_resource_repo.get_by_id(*queue).await?;
                    result_queues.push(queue);
                }
            }
            SchedulingStrategy::Auto => {
                let queues = self.get_all_quques().await?;
                result_queues.extend(queues);
            }
            SchedulingStrategy::Prefer { queues } => {
                for queue in queues {
                    let queue = self.queue_resource_repo.get_by_id(*queue).await?;
                    result_queues.push(queue);
                }
            }
        };

        let mut not_full_queues = vec![];
        for queue in result_queues {
            if queue.enabled && Queue::is_resource_full(&queue).await.is_ok() {
                not_full_queues.push(queue);
            }
        }
        if not_full_queues.is_empty() {
            let change_msg = ChangeMsg {
                id: task_id,
                info: Info::Task(TaskChangeInfo {
                    status: TaskStatusChange::Failed,
                    message: Some("no queue available".to_string()),
                    used_resources: None,
                }),
            };
            let prefer_fallback_queues = self.get_all_quques().await?;
            let mut not_full_queue = vec![];
            for queue in prefer_fallback_queues {
                if queue.enabled && Queue::is_resource_full(&queue).await.is_ok() {
                    not_full_queue.push(queue);
                }
            }
            if not_full_queue.is_empty() {
                self.status_mq_producer.send_object(&change_msg, &self.status_mq_topic).await?;
                bail!("no queue available");
            }

            self.status_mq_producer.send_object(&change_msg, &self.status_mq_topic).await?;
            bail!("no queue available");
        }

        Ok(not_full_queues
            .first()
            .context("ResourcesService impossible error.")?
            .to_owned())
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
