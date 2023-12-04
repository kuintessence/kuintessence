use std::sync::Arc;

use crate::infrastructure::service::file_upload_runner::FileUploadRunner;
use alice_di::IServiceProvider;
use alice_infrastructure::middleware::authorization::{AliceScopedConfig, UserInfo};
use domain_storage::command::FileUploadCommand;
use domain_workflow::{
    model::vo::msg::{ChangeMsg, Info},
    service::ScheduleService,
};
use infrastructure_command::WsServerOperateCommand;
use service_workflow::{FlowScheduleServiceImpl, NodeScheduleServiceImpl, TaskScheduleServiceImpl};

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
pub async fn status_consumer(
    #[inject] task_service: Arc<TaskScheduleServiceImpl>,
    #[inject] node_service: Arc<NodeScheduleServiceImpl>,
    #[inject] flow_service: Arc<FlowScheduleServiceImpl>,

    #[serialize] msg: ChangeMsg,
) -> anyhow::Result<()> {
    let id = msg.id;
    match msg.info {
        Info::Task(info) => task_service.change(id, info).await?,
        Info::Node(info) => node_service.change(id, info).await?,
        Info::Flow(info) => flow_service.change(id, info).await?,
    }
    Ok(())
}
