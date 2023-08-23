use crate::infrastructure::ServiceProvider;
use actix_web::web::{Json, Path};
use actix_web::{get, post, web};
use alice_architecture::base_dto::ResponseBase;
use alice_architecture::exceptions::GenericError;
use alice_di::actix_auto_inject;
use alice_di::IServiceProvider;
use kernel::prelude::*;
use std::str::FromStr;

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("workflow-engine/NodeCmd/{node_id}")]
pub async fn get_node_cmd(
    #[inject] service: std::sync::Arc<SoftwareComputingUsecaseService>,
    node_id: Path<String>,
) -> web::Json<ResponseBase<Option<String>>> {
    let node_id = match Uuid::from_str(&node_id) {
        Ok(node_id) => node_id,
        Err(e) => {
            log::error!("submit_workflow uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };
    Json(match service.get_cmd(node_id).await {
        Ok(el) => ResponseBase::ok(Some(el)),
        Err(e) => {
            log::error!("{}", e);
            ResponseBase::err(500, "Interval Error.")
        }
    })
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("workflow-engine/SubmitWorkflow/{id}")]
pub async fn submit_workflow(
    #[inject] service: std::sync::Arc<dyn IWorkflowService + Send + Sync>,
    id: Path<String>,
) -> web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("submit_workflow uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };
    let response = match service.submit_workflow(id).await {
        Ok(x) => ResponseBase::ok(Some(x.to_string())),
        Err(e) => {
            log::error!("{}", e);
            match e.downcast::<GenericError<WorkflowDraftException>>() {
                Ok(e) => match e {
                    GenericError::Unknown => ResponseBase::err(500, "未知错误"),
                    GenericError::Infrastructure(..) => ResponseBase::err(500, "Interval Error."),
                    GenericError::Logic(..) => ResponseBase::err(400, "Logic Error."),
                    GenericError::Specific(e2) => ResponseBase::err(400, e2.to_string().as_str()),
                },
                Err(_) => ResponseBase::err(400, "Interval Error."),
            }
        }
    };
    web::Json(response)
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("workflow-engine/StartWorkflow/{id}")]
pub async fn start_workflow(
    #[inject] service: std::sync::Arc<dyn IWorkflowService + Send + Sync>,
    id: Path<String>,
) -> web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("start_workflow uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };
    match service.start_workflow(id).await {
        Ok(()) => web::Json(ResponseBase::ok(Some(id.to_string()))),
        Err(e) => {
            log::error!("{}", e);
            web::Json(ResponseBase::err(400, "Error"))
        }
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[post("workflow-engine/ReceiveNodeStatus")]
pub async fn receive_node_status(
    #[inject] service: std::sync::Arc<dyn IWorkflowStatusReceiverService + Send + Sync>,
    task_result: web::Json<TaskResult>,
) -> web::Json<ResponseBase<String>> {
    let task_result = task_result.0;
    match service.receive_node_status(task_result.to_owned()).await {
        Ok(()) => web::Json(ResponseBase::ok(Some(task_result.id.to_string()))),
        Err(e) => {
            log::error!("{}", e);
            web::Json(ResponseBase::err(400, "Error"))
        }
    }
}

#[alice_di::auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::message_consumer]
pub async fn node_status_consumer(
    #[inject] service: std::sync::Arc<dyn IWorkflowStatusReceiverService + Send + Sync>,
    #[serialize] task_result: TaskResult,
) -> anyhow::Result<()> {
    service.receive_node_status(task_result).await
}

// #[alice_di::auto_inject(ServiceProvider, scoped = "None")]
// #[alice_web_macro::message_consumer]
// pub async fn file_upload_runner_consumer(
//     #[inject] service: std::sync::Arc<dyn IFileUploadService + Send + Sync>,
//     #[serialize] command: FileTransportCommand,
// ) -> anyhow::Result<()> {
//     service.transport(command).await
// }

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("workflow-engine/PauseWorkflow/{id}")]
pub async fn pause_workflow(
    #[inject] service: std::sync::Arc<dyn IWorkflowScheduleService + Send + Sync>,
    id: Path<String>,
) -> web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("pause_workflow uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };
    match service.pause_workflow(id).await {
        Ok(()) => web::Json(ResponseBase::ok(Some(id.to_string()))),
        Err(e) => {
            log::error!("{}", e);
            web::Json(ResponseBase::err(400, "Error"))
        }
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("workflow-engine/ContinueWorkflow/{id}")]
pub async fn continue_workflow(
    #[inject] service: std::sync::Arc<dyn IWorkflowScheduleService + Send + Sync>,
    id: Path<String>,
) -> web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("continue_workflow uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };
    match service.continue_workflow(id).await {
        Ok(()) => web::Json(ResponseBase::ok(Some(id.to_string()))),
        Err(e) => {
            log::error!("{}", e);
            web::Json(ResponseBase::err(400, "Error"))
        }
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("workflow-engine/TerminateWorkflow/{id}")]
pub async fn terminate_workflow(
    #[inject] service: std::sync::Arc<dyn IWorkflowScheduleService + Send + Sync>,
    id: Path<String>,
) -> web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("terminate_workflow uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };
    match service.terminate_workflow(id).await {
        Ok(()) => web::Json(ResponseBase::ok(Some(id.to_string()))),
        Err(e) => {
            log::error!("{}", e);
            web::Json(ResponseBase::err(400, "Error"))
        }
    }
}
