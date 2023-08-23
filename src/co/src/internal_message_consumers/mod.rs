use crate::infrastructure::{external_services::IFileUploadRunner, ServiceProvider};
use alice_architecture::UserInfo;
use alice_di::IServiceProvider;
use kernel::prelude::*;

#[alice_di::auto_inject(
    ServiceProvider,
    scoped = "Some(UserInfo{user_id:command.user_id.to_string(),..Default::default()})"
)]
#[alice_web_macro::message_consumer]
pub async fn file_upload_runner_consumer(
    #[inject] service: Arc<dyn IFileUploadRunner + Send + Sync>,
    #[serialize] command: FileUploadCommand,
) -> Anyhow {
    service.upload_file(command).await
}

#[alice_di::auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::message_consumer]
pub async fn realtime_file_consumer(
    #[inject] service: Arc<dyn IRealtimeService + Send + Sync>,
    #[serialize] command: (
        // client id
        Uuid,
        ViewRealtimeCommand,
    ),
) -> anyhow::Result<()> {
    service.request_realtime_file(command.0, command.1).await
}

#[alice_di::auto_inject(ServiceProvider)]
#[alice_web_macro::message_consumer]
pub async fn ws_server_file_consumer(
    #[inject] ws_sender: flume::Sender<WsServerOperateCommand>,
    #[serialize] msg: WsServerOperateCommand,
) -> anyhow::Result<()> {
    ws_sender.send_async(msg).await?;
    Ok(())
}
