use actix_http::header::LanguageTag;
use actix_web::{
    get,
    web::{Path, Query},
};
use alice_di::{actix_auto_inject, IServiceProvider};
use alice_infrastructure::error::{AliceError, AliceResponder, AliceResponderResult};
use domain_content_repo::{model::vo::NodeDraft, service::NodeDraftService};
use domain_workflow::service::ControlService;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::{api::extract_uuid, infrastructure::ServiceProvider};

#[derive(Debug, Deserialize)]
pub struct GetWorkflowComponentRequest {
    usecase_version_id: String,
    software_version_id: String,
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[tracing::instrument(skip(sp))]
#[get("workflow-editor/ValidateWorkflowDraft/{id}")]
pub async fn validate_workflow_draft(
    #[inject] service: std::sync::Arc<dyn ControlService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.validate(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider)]
#[tracing::instrument(skip(sp))]
#[get("workflow-editor/GetNodeDraft")]
pub async fn get_node_draft(
    #[inject] node_draft_sv: Arc<dyn NodeDraftService>,
    request: Query<GetWorkflowComponentRequest>,
) -> AliceResponderResult<NodeDraft> {
    let node_draft = node_draft_sv
        .get_node_draft(
            extract_uuid(&request.usecase_version_id)?,
            extract_uuid(&request.software_version_id)?,
        )
        .await?;
    Ok(AliceResponder(node_draft))
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
) -> AliceResponder<Vec<GetWorkflowComponentCategoriesResponse>> {
    let tag = match LanguageTag::parse(language_tag.lang.clone().unwrap_or_default().as_str()) {
        Ok(x) => x,
        Err(_) => LanguageTag::parse("en-US").unwrap(),
    };
    let categories = match tag.primary_language() {
        "zh" => match tag.script() {
            Some("Hant") => vec![
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
            ],
            _ => vec![
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
            ],
        },
        _ => vec![
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
        ],
    };
    AliceResponder(categories)
}
