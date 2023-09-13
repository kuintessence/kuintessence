use std::sync::Arc;

use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use alice_architecture::repository::ReadOnlyRepository;
use async_trait::async_trait;
use domain_workflow::{
    model::entity::{Queue, Task},
    service::TaskDistributionService,
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct TaskDistributionServiceImpl {
    queue_repository: Arc<dyn ReadOnlyRepository<Queue> >,
    mqproducer: Arc<dyn MessageQueueProducerTemplate<Task> >,
}

#[async_trait]
impl TaskDistributionService for TaskDistributionServiceImpl {
    async fn send_task(&self, task: &Task, queue_id: Uuid) -> anyhow::Result<()> {
        let queue = self.queue_repository.get_by_id(queue_id).await?;
        let topic = queue.topic_name;
        Ok(self.mqproducer.send_object(task, Some(&topic)).await?)
    }
}
