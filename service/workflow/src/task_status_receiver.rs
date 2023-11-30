use std::sync::Arc;

use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use anyhow::Context;
use async_trait::async_trait;
use domain_workflow::{
    model::vo::{
        msg::{ChangeMsg, Info, TaskChangeInfo},
        task_dto::result::TaskResult,
    },
    service::{QueueResourceService, TaskStatusReceiveService},
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct TaskStatusReceiveServiceImpl {
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
    queue_resource_service: Arc<dyn QueueResourceService>,
    queue_id: Option<Uuid>,
}

#[async_trait]
impl TaskStatusReceiveService for TaskStatusReceiveServiceImpl {
    /// Receive task result.
    async fn receive_status(&self, result: TaskResult) -> anyhow::Result<()> {
        match result.status.try_into() {
            Ok(status) => {
                self.status_mq_producer
                    .send_object(
                        &ChangeMsg {
                            id: result.id,
                            info: Info::Task(TaskChangeInfo {
                                status,
                                message: result.message,
                                used_resources: result.used_resources,
                            }),
                        },
                        Some(&self.status_mq_topic),
                    )
                    .await?;
            }
            Err(_) => {
                self.queue_resource_service
                    .task_started(
                        self.queue_id
                            .context("No queue id when TaskStatusReceiveService use it.")?,
                    )
                    .await?
            }
        }
        Ok(())
    }
}
