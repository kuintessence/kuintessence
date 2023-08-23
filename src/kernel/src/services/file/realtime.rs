use crate::prelude::*;
use alice_architecture::message_queue::IMessageQueueProducerTemplate;

#[derive(Builder)]
pub struct RealtimeService {
    kafka_mq_producer: Arc<dyn IMessageQueueProducerTemplate<ViewRealtimeCommand> + Send + Sync>,
    ws_file_redis_repo: Arc<dyn IWsReqInfoRepo + Send + Sync>,
    innner_mq_producer:
        Arc<dyn IMessageQueueProducerTemplate<WsServerOperateCommand> + Send + Sync>,
    #[builder(default = "default_realtime_request_topic()")]
    realtime_request_topic: String,
    #[builder(default = "default_ws_send_to_client_topic()")]
    ws_server_operate_topic: String,
    #[builder(default = "60 * 60 * 1000")]
    exp_msecs: i64,
}
fn default_realtime_request_topic() -> String {
    "realtime-request".to_string()
}
fn default_ws_send_to_client_topic() -> String {
    "ws-send-to-client".to_string()
}

fn key(req_id: Uuid, client_id: Uuid) -> String {
    format!("{req_id}_{client_id}")
}
fn req_id_key_regex(req_id: Uuid) -> String {
    format!("{req_id}_*")
}

#[async_trait]
impl IRealtimeService for RealtimeService {
    async fn request_realtime_file(&self, client_id: Uuid, mut cmd: ViewRealtimeCommand) -> Anyhow {
        self.kafka_mq_producer
            .send_object(&cmd, Some(&self.realtime_request_topic))
            .await?;
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
        let client_id = self.get_client_id(request_id).await?;
        self.innner_mq_producer
            .send_object(
                &WsServerOperateCommand::SendContentToSession {
                    client_id,
                    content: file_content.to_owned(),
                },
                Some(&self.ws_server_operate_topic),
            )
            .await
    }
}

impl RealtimeService {
    async fn get_client_id(&self, request_id: Uuid) -> AnyhowResult<Uuid> {
        Ok(self
            .ws_file_redis_repo
            .get_one_by_key_regex(&req_id_key_regex(request_id))
            .await?
            .ok_or(anyhow!("No such req id: {request_id}"))?
            .client_id)
    }
}
