use std::sync::Arc;

use alice_infrastructure::middleware::authorization::{AliceScopedConfig, UserInfo};
use domain_storage::command::FileUploadCommand;
use domain_workflow::{model::entity::task::TaskResult, service::WorkflowStatusReceiverService};
use infrastructure_command::WsServerOperateCommand;
use alice_di::IServiceProvider;
use crate::infrastructure::service::file_upload_runner::FileUploadRunner;

use super::ServiceProvider;

#[alice_di::auto_inject(ServiceProvider, scoped(AliceScopedConfig{user_info:Some(UserInfo{id:command.user_id}),..Default::default()}))]
#[alice_web::message_consumer]
pub async fn file_upload_runner_consumer(
    #[inject] service: Arc<FileUploadRunner>,
    #[serialize] command: FileUploadCommand,
) -> anyhow::Result<()> {
    service.upload_file(command.move_id).await
}

#[alice_di::auto_inject(ServiceProvider)]
#[alice_web::message_consumer]
pub async fn ws_server_operator(
    #[inject] ws_sender: flume::Sender<WsServerOperateCommand>,
    #[serialize] msg: WsServerOperateCommand,
) -> anyhow::Result<()> {
    ws_sender.send_async(msg).await?;
    Ok(())
}

#[alice_di::auto_inject(ServiceProvider, scoped)]
#[alice_web::message_consumer]
pub async fn node_status_consumer(
    #[inject] service: std::sync::Arc<dyn WorkflowStatusReceiverService >,
    #[serialize] task_result: TaskResult,
) -> anyhow::Result<()> {
    service.receive_node_status(task_result).await
}
