use crate::api::extract_uuid;
use crate::infrastructure::ServiceProvider;
use actix_web::web::Path;
use actix_web::{get, post, web};
use alice_di::actix_auto_inject;
use alice_di::IServiceProvider;
use alice_infrastructure::error::{
    AliceCommonError, AliceError, AliceResponder, AliceResponderResult,
};
use domain_workflow::service::{
    SoftwareComputingUsecaseService, WorkflowScheduleService, WorkflowService,
};
use uuid::Uuid;

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/NodeCmd/{node_id}")]
pub async fn get_node_cmd(
    #[inject] service: std::sync::Arc<dyn SoftwareComputingUsecaseService>,
    node_id: Path<String>,
) -> AliceResponderResult<Option<String>> {
    let node_id = extract_uuid(&node_id)?;
    let cmd = service.get_cmd(node_id).await?;
    Ok(AliceResponder(cmd))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/SubmitWorkflow/{id}")]
pub async fn submit_workflow(
    #[inject] service: std::sync::Arc<dyn WorkflowService>,
    id: Path<String>,
) -> AliceResponderResult<Uuid> {
    let id = extract_uuid(&id)?;
    let instance_id = service.submit_workflow(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(instance_id))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/StartWorkflow/{id}")]
pub async fn start_workflow(
    #[inject] service: std::sync::Arc<dyn WorkflowService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.start_workflow(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}

// #[actix_auto_inject(ServiceProvider, scoped)]
// #[post("workflow-engine/ReceiveNodeStatus")]
// pub async fn receive_node_status(
//     #[inject] service: std::sync::Arc<dyn WorkflowStatusReceiverService>,
//     mut task_result: web::Json<TaskResult>,
// ) -> AliceResponderResult<()> {
//     let device_info =
//         scoped_config
//             .device_info
//             .ok_or(AliceError::new(AliceCommonError::InternalError {
//                 source: anyhow::anyhow!("No device info in scoped config."),
//             }))?;
//     let queue_id = device_info.id;
//     if let TaskResultStatus::Start(id) = &mut task_result.0.status {
//         *id = Some(queue_id)
//     }
//     let task_result = task_result.0;
//     service.receive_node_status(task_result.to_owned()).await?;
//     Ok(AliceResponder(()))
// }

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/PauseWorkflow/{id}")]
pub async fn pause_workflow(
    #[inject] service: std::sync::Arc<dyn WorkflowScheduleService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.pause_workflow(id).await?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/ContinueWorkflow/{id}")]
pub async fn continue_workflow(
    #[inject] service: std::sync::Arc<dyn WorkflowScheduleService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.continue_workflow(id).await?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/TerminateWorkflow/{id}")]
pub async fn terminate_workflow(
    #[inject] service: std::sync::Arc<dyn WorkflowScheduleService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.terminate_workflow(id).await?;
    Ok(AliceResponder(()))
}
