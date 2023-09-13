use anyhow::anyhow;
use std::sync::Arc;

use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate, repository::ReadOnlyRepository,
};
use async_trait::async_trait;
use domain_storage::{command::ViewRealtimeCommand, service::RealtimeService};
use domain_workflow::{model::entity::Queue, repository::NodeInstanceRepo};
use infrastructure_command::WsServerOperateCommand;
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct RealtimeServiceImpl {
    kafka_mq_producer: Arc<dyn MessageQueueProducerTemplate<ViewRealtimeCommand>>,
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
    queue_repository: Arc<dyn ReadOnlyRepository<Queue>>,
    innner_mq_producer: Arc<dyn MessageQueueProducerTemplate<WsServerOperateCommand>>,
    #[builder(default = "ws-send-to-client".to_owned())]
    ws_server_operate_topic: String,
    user_id: Option<Uuid>,
}

impl RealtimeServiceImpl {
    fn user_id(&self) -> anyhow::Result<Uuid> {
        self.user_id.ok_or(anyhow!("No user id when realtime service use it."))
    }
}

#[async_trait]
impl RealtimeService for RealtimeServiceImpl {
    async fn request_realtime_file(&self, cmd: ViewRealtimeCommand) -> anyhow::Result<()> {
        let node_instance = self.node_instance_repository.get_by_id(cmd.node_id).await?;

        let queue_id = node_instance.queue_id.ok_or(anyhow!("node instance has no queue id"))?;

        let topic_name = self.queue_repository.get_by_id(queue_id).await?.topic_name;

        self.kafka_mq_producer.send_object(&cmd, Some(&topic_name)).await?;

        Ok(())
    }

    async fn responde_realtime(&self, file_content: &str) -> anyhow::Result<()> {
        self.innner_mq_producer
            .send_object(
                &WsServerOperateCommand::SendContentToSession {
                    id: self.user_id()?,
                    content: format!("realtime {}", file_content),
                },
                Some(&self.ws_server_operate_topic),
            )
            .await
    }
}
