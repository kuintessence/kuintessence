use crate::prelude::*;
use alice_architecture::{
    message_queue::IMessageQueueProducerTemplate, repository::IReadOnlyRepository,
};
use std::sync::Arc;

#[derive(Builder)]
pub struct TaskDistributionService {
    cluster_repository: Arc<dyn IReadOnlyRepository<Cluster> + Send + Sync>,
    mqproducer: Arc<dyn IMessageQueueProducerTemplate<Task> + Send + Sync>,
}

#[async_trait]
impl ITaskDistributionService for TaskDistributionService {
    async fn send_task(&self, task: &Task, cluster_id: Uuid) -> anyhow::Result<()> {
        let cluster = self.cluster_repository.get_by_id(&cluster_id.to_string()).await?;
        let topic = cluster.topic_name;
        Ok(self.mqproducer.send_object(task, Some(&topic)).await?)
    }
}
