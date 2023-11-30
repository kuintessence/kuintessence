use std::sync::Arc;

use crate::api::extract_uuid;
use crate::infrastructure::ServiceProvider;
use actix_web::web;
use actix_web::web::Path;
use actix_web::{get, post};
use alice_di::actix_auto_inject;
use alice_di::IServiceProvider;
use alice_infrastructure::error::{AliceError, AliceResponder, AliceResponderResult};
use domain_workflow::model::vo::task_dto::result::TaskResult;
use domain_workflow::service::TaskStatusReceiveService;
use domain_workflow::service::{ControlService, UsecaseParseService};
use service_workflow::SoftwareComputingUsecaseServiceImpl;
use uuid::Uuid;

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/NodeCmd/{node_id}")]
pub async fn get_node_cmd(
    #[inject] service: Arc<SoftwareComputingUsecaseServiceImpl>,
    node_id: Path<String>,
) -> AliceResponderResult<Option<String>> {
    let node_id = extract_uuid(&node_id)?;
    let cmd = service.get_cmd(node_id).await?;
    Ok(AliceResponder(cmd))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/SubmitWorkflow/{id}")]
pub async fn submit_workflow(
    #[inject] service: Arc<dyn ControlService>,
    id: Path<String>,
) -> AliceResponderResult<Uuid> {
    let id = extract_uuid(&id)?;
    let instance_id = service.submit(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(instance_id))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/StartWorkflow/{id}")]
pub async fn start_workflow(
    #[inject] service: Arc<dyn ControlService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.start(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("workflow-engine/ReceiveTaskStatus")]
pub async fn receive_task_status(
    #[inject] service: Arc<dyn TaskStatusReceiveService>,
    task_result: web::Json<TaskResult>,
) -> AliceResponderResult<()> {
    service.receive_status(task_result.0).await?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/PauseWorkflow/{id}")]
pub async fn pause_workflow(
    #[inject] service: Arc<dyn ControlService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.pause(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/ContinueWorkflow/{id}")]
pub async fn continue_workflow(
    #[inject] service: Arc<dyn ControlService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.resume(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("workflow-engine/TerminateWorkflow/{id}")]
pub async fn terminate_workflow(
    #[inject] service: Arc<dyn ControlService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.terminate(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}
