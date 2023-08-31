use alice_architecture::utils::*;
use alice_architecture::UserInfo;
use alice_di::IServiceProvider;
use domain_storage::command::{FileUploadCommand, ViewRealtimeCommand};
use domain_storage::service::RealtimeService;
use infrastructure_command::WsServerOperateCommand;

use super::service::file_upload_runner::FileUploadRunner;
use super::ServiceProvider;

#[alice_di::auto_inject(
    ServiceProvider,
    scoped = "Some(UserInfo{user_id:command.user_id.to_string(),..Default::default()})"
)]
#[alice_web::message_consumer]
pub async fn file_upload_runner_consumer(
    #[inject] service: Arc<FileUploadRunner>,
    #[serialize] command: FileUploadCommand,
) -> Anyhow {
    service.upload_file(command).await
}

#[alice_di::auto_inject(ServiceProvider, scoped = "None")]
#[alice_web::message_consumer]
pub async fn realtime_file_consumer(
    #[inject] service: Arc<dyn RealtimeService>,
    #[serialize] command: (
        // session id
        Uuid,
        ViewRealtimeCommand,
    ),
) -> anyhow::Result<()> {
    service.request_realtime_file(command.0, command.1).await
}

#[alice_di::auto_inject(ServiceProvider)]
#[alice_web::message_consumer]
pub async fn ws_server_file_consumer(
    #[inject] ws_sender: flume::Sender<WsServerOperateCommand>,
    #[serialize] msg: WsServerOperateCommand,
) -> anyhow::Result<()> {
    ws_sender.send_async(msg).await?;
    Ok(())
}
