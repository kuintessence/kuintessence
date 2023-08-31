use std::sync::Arc;

use alice_architecture::message_queue::IMessageQueueProducerTemplate;
use alice_architecture::utils::Anyhow;
use alice_architecture::IReadOnlyRepository;
use anyhow::{anyhow, Context};
use async_trait::async_trait;
use domain_storage::{
    command::ViewRealtimeCommand, model::entity::WsReqInfo, repository::WsReqInfoRepo,
    service::RealtimeService,
};
use domain_workflow::{model::entity::Queue, repository::NodeInstanceRepo};
use infrastructure_command::WsServerOperateCommand;
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct RealtimeServiceImpl {
    kafka_mq_producer: Arc<dyn IMessageQueueProducerTemplate<ViewRealtimeCommand> + Send + Sync>,
    ws_file_redis_repo: Arc<dyn WsReqInfoRepo>,
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
    queue_repository: Arc<dyn IReadOnlyRepository<Queue> + Send + Sync>,
    inner_mq_producer: Arc<dyn IMessageQueueProducerTemplate<WsServerOperateCommand> + Send + Sync>,
    #[builder(default = "ws-send-to-client".to_owned())]
    ws_server_operate_topic: String,
    #[builder(default = 60 * 60 * 1000)]
    exp_msecs: i64,
}

fn key(req_id: Uuid, session_id: Uuid) -> String {
    format!("{req_id}_{session_id}")
}

fn req_id_key_regex(req_id: Uuid) -> String {
    format!("{req_id}_*")
}

#[async_trait]
impl RealtimeService for RealtimeServiceImpl {
    async fn request_realtime_file(&self, client_id: Uuid, mut cmd: ViewRealtimeCommand) -> Anyhow {
        let node_instance =
            self.node_instance_repository.get_by_id(&cmd.node_id.to_string()).await?;
        let queue_id = node_instance.queue_id.context("node instance has no queue id")?;
        let topic_name = self.queue_repository.get_by_id(&queue_id.to_string()).await?.topic_name;

        self.kafka_mq_producer.send_object(&cmd, Some(&topic_name)).await?;
        if cmd.req_id.is_nil() {
            cmd.req_id = Uuid::new_v4();
        }
        let ws_req_info = WsReqInfo {
            request_id: cmd.req_id,
            client_id,
        };
        self.ws_file_redis_repo
            .insert_with_lease(&key(cmd.req_id, client_id), ws_req_info, self.exp_msecs)
            .await?;
        Ok(())
    }

    async fn send_realtime(&self, request_id: Uuid, file_content: &str) -> Anyhow {
        let session_id = self.get_client_id(request_id).await?;
        self.inner_mq_producer
            .send_object(
                &WsServerOperateCommand::SendContentToSession {
                    id: session_id,
                    content: file_content.to_owned(),
                },
                Some(&self.ws_server_operate_topic),
            )
            .await
    }
}

impl RealtimeServiceImpl {
    async fn get_client_id(&self, request_id: Uuid) -> Anyhow<Uuid> {
        Ok(self
            .ws_file_redis_repo
            .get_one_by_key_regex(&req_id_key_regex(request_id))
            .await?
            .ok_or(anyhow!("No such req id: {request_id}"))?
            .client_id)
    }
}
