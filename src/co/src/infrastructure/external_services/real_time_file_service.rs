use crate::infrastructure::ws::IWsManager;
use alice_architecture::{
    message_queue::IMessageQueueProducerTemplate, repository::ILeaseDBRepository,
};
use kernel::{IRealTimeFileService, RealTimeFileInfo, WsFileInfo};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct RealTimeFileService {
    message_queue_producer: Arc<dyn IMessageQueueProducerTemplate<RealTimeFileInfo> + Send + Sync>,
    ws_file_redis_repo: Arc<dyn ILeaseDBRepository<WsFileInfo> + Send + Sync>,
    ws_manager: Arc<Mutex<dyn IWsManager + Send + Sync>>,
    topic: String,
}

impl RealTimeFileService {
    pub fn new(
        message_queue_producer: Arc<
            dyn IMessageQueueProducerTemplate<RealTimeFileInfo> + Send + Sync,
        >,
        ws_file_redis_repo: Arc<dyn ILeaseDBRepository<WsFileInfo> + Send + Sync>,
        ws_manager: Arc<Mutex<dyn IWsManager + Send + Sync>>,
        topic: String,
    ) -> Self {
        Self {
            message_queue_producer,
            ws_file_redis_repo,
            ws_manager,
            topic,
        }
    }
}

#[async_trait::async_trait(?Send)]
impl IRealTimeFileService for RealTimeFileService {
    async fn request_real_time_file(&self, info: RealTimeFileInfo) -> anyhow::Result<()> {
        self.message_queue_producer
            .send_object(&info, Some(&self.topic))
            .await?;
        let request_id = info.requset_id;
        let client_id = info.cilent_id;
        let ws_file_info = WsFileInfo::new(request_id, client_id);
        self.ws_file_redis_repo
            .insert_with_lease(
                request_id.to_string().as_str(),
                ws_file_info,
                60 * 60 * 1000,
            )
            .await?;
        Ok(())
    }
    async fn send_message(&mut self, client_id: &str, file_content: &str) -> anyhow::Result<()> {
        self.ws_manager
            .lock()
            .await
            .send_message(client_id, file_content)
            .await
    }

    async fn get_ws_file_info(&self, request_id: &str) -> anyhow::Result<WsFileInfo> {
        self.ws_file_redis_repo
            .get_by_id(&request_id.to_string())
            .await
    }
}
