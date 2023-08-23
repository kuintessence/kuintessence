use crate::infrastructure::ServiceProvider;
use actix_http::header::LanguageTag;
use actix_web::{
    get,
    web::{Json, Path, Query},
};
use alice_architecture::{base_dto::ResponseBase, GenericError};
use alice_di::{actix_auto_inject, IServiceProvider};
use kernel::prelude::*;
use lib_co_repo::{client::*, dtos::prelude::NodeDraft};
use std::str::FromStr;

#[derive(Debug, Deserialize)]
pub struct GetWorkflowComponentRequest {
    usecase_version_id: String,
    software_version_id: String,
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[tracing::instrument(skip(sp))]
#[get("workflow-editor/ValidateWorkflowDraft/{id}")]
pub async fn validate_workflow_draft(
    #[inject] service: std::sync::Arc<dyn IWorkflowService + Send + Sync>,
    id: Path<String>,
) -> Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("validate_workflow_draft uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };
    let response = match service.validate(id).await {
        Ok(()) => ResponseBase::ok(Some("Validate passed.".to_string())),
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
    Json(response)
}

#[actix_auto_inject(ServiceProvider)]
#[tracing::instrument(skip(sp))]
#[get("workflow-editor/GetNodeDraft")]
pub async fn get_node_draft(
    #[inject] client: Arc<dyn IInfoGetter + Send + Sync>,
    request: Query<GetWorkflowComponentRequest>,
) -> Json<ResponseBase<NodeDraft>> {
    match client
        .get_node_draft(
            uuid::Uuid::from_str(&request.usecase_version_id).unwrap(),
            uuid::Uuid::from_str(&request.software_version_id).unwrap(),
        )
        .await
    {
        Ok(x) => Json(ResponseBase::ok(Some(x))),
        Err(e) => {
            log::error!("{}", e);
            Json(ResponseBase::err(400, "Error"))
        }
    }
}

#[derive(Debug, Serialize)]
pub struct GetWorkflowComponentCategoriesResponse {
    pub name: String,
    pub display_name: String,
    pub id: String,
    pub is_active: bool,
}

#[derive(Debug, Deserialize)]
pub struct GetLanguageRequest {
    pub lang: Option<String>,
}

#[get("workflow-editor/GetComponentCategories")]
pub async fn get_workflow_component_categories(
    language_tag: Query<GetLanguageRequest>,
) -> Json<ResponseBase<Vec<GetWorkflowComponentCategoriesResponse>>> {
    let tag = match LanguageTag::parse(language_tag.lang.clone().unwrap_or_default().as_str()) {
        Ok(x) => x,
        Err(_) => LanguageTag::parse("en-US").unwrap(),
    };
    match tag.primary_language() {
        "zh" => match tag.script() {
            Some("Hant") => Json(ResponseBase::ok(Some(vec![
                GetWorkflowComponentCategoriesResponse {
                    name: "content_repos".to_string(),
                    display_name: "高性能计算".to_string(),
                    id: "d3a6c90e-29d0-4d50-b5f4-f6b67643864a".to_string(),
                    is_active: true,
                },
                GetWorkflowComponentCategoriesResponse {
                    name: "big_data_process".to_string(),
                    display_name: "大数据处理".to_string(),
                    id: "52c02a14-9493-432f-9599-146109f71ee3".to_string(),
                    is_active: false,
                },
                GetWorkflowComponentCategoriesResponse {
                    name: "ai_resoning".to_string(),
                    display_name: "AI 推理".to_string(),
                    id: "1109cbbb-4830-4e1d-ab66-1f019b3b321b".to_string(),
                    is_active: false,
                },
            ]))),
            _ => Json(ResponseBase::ok(Some(vec![
                GetWorkflowComponentCategoriesResponse {
                    name: "content_repos".to_string(),
                    display_name: "高性能计算".to_string(),
                    id: "d3a6c90e-29d0-4d50-b5f4-f6b67643864a".to_string(),
                    is_active: true,
                },
                GetWorkflowComponentCategoriesResponse {
                    name: "big_data_process".to_string(),
                    display_name: "大数据处理".to_string(),
                    id: "52c02a14-9493-432f-9599-146109f71ee3".to_string(),
                    is_active: false,
                },
                GetWorkflowComponentCategoriesResponse {
                    name: "ai_resoning".to_string(),
                    display_name: "AI 推理".to_string(),
                    id: "1109cbbb-4830-4e1d-ab66-1f019b3b321b".to_string(),
                    is_active: false,
                },
            ]))),
        },
        _ => Json(ResponseBase::ok(Some(vec![
            GetWorkflowComponentCategoriesResponse {
                name: "content_repos".to_string(),
                display_name: "Content Repos".to_string(),
                id: "d3a6c90e-29d0-4d50-b5f4-f6b67643864a".to_string(),
                is_active: true,
            },
            GetWorkflowComponentCategoriesResponse {
                name: "big_data_process".to_string(),
                display_name: "Big Data Process".to_string(),
                id: "52c02a14-9493-432f-9599-146109f71ee3".to_string(),
                is_active: false,
            },
            GetWorkflowComponentCategoriesResponse {
                name: "ai_resoning".to_string(),
                display_name: "AI Resoning".to_string(),
                id: "1109cbbb-4830-4e1d-ab66-1f019b3b321b".to_string(),
                is_active: false,
            },
        ]))),
    }
}
