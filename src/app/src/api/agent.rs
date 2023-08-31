use std::str::FromStr;
use std::sync::Arc;

use actix_web::web::{Json, Path};
use actix_web::{get, post, web};
use alice_architecture::base_dto::ResponseBase;
use alice_di::{actix_auto_inject, IServiceProvider};
use domain_workflow::{model::entity::queue::*, service::QueueResourceService};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::infrastructure::ServiceProvider;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRegisterDto {
    pub memory: i64,
    pub core_number: i64,
    pub storage_capacity: i64,
    pub node_number: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateUsedResourceDto {
    pub allocated_memory: i64,
    pub allocated_cpu_count: i64,
    pub used_storage: i64,
    pub queuing_task_count: i64,
    pub running_task_count: i64,
    pub used_node_count: i64,
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info.clone()")]
#[alice_web::http_request]
#[alice_web::authorize]
#[post("agent/Register")]
pub async fn register(
    #[inject] service: Arc<dyn QueueResourceService>,
    data: web::Json<AgentRegisterDto>,
) -> Json<ResponseBase<()>> {
    let user_info = user_info.unwrap();
    let name = user_info.preferred_username;
    let id = match Uuid::from_str(&user_info.user_id) {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("{e}");
            return Json(ResponseBase::err(400, "Invalid queue id."));
        }
    };
    match service
        .insert_queue(&Queue {
            id,
            name: name.to_owned(),
            memory: data.memory,
            core_number: data.core_number,
            storage_capacity: data.storage_capacity,
            node_count: data.node_number,
            topic_name: name,
            enabled: true,
            ..Default::default()
        })
        .await
    {
        Ok(_) => Json(ResponseBase::ok(None)),
        Err(e) => {
            tracing::error!("{e}");
            Json(ResponseBase::err(500, "Interval error."))
        }
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info.clone()")]
#[alice_web::http_request]
#[alice_web::authorize]
#[post("agent/UpdateUsedResource")]
pub async fn update_used_resource(
    #[inject] service: Arc<dyn QueueResourceService>,
    data: web::Json<UpdateUsedResourceDto>,
) -> Json<ResponseBase<()>> {
    let user_info = user_info.unwrap();
    let id = match Uuid::from_str(&user_info.user_id) {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("{e}");
            return Json(ResponseBase::err(400, "Invalid queue id."));
        }
    };
    service
        .update_queue_resource(
            id,
            &QueueCacheInfo {
                used: QueueResourceUsed {
                    memory_used: data.allocated_memory,
                    core_number_used: data.allocated_cpu_count,
                    storage_capacity_used: data.used_storage,
                    node_number_used: data.used_node_count,
                },
                task_count: QueueTaskCount {
                    queuing_task_count: data.queuing_task_count,
                    running_task_count: data.running_task_count,
                },
            },
        )
        .await;
    Json(ResponseBase::ok(None))
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web::http_request]
#[alice_web::authorize]
#[get("agent/GetQueueCacheInfo/{id}")]
pub async fn get_queue_cache_info(
    #[inject] service: Arc<dyn QueueResourceService>,
    id: Path<String>,
) -> Json<ResponseBase<UpdateUsedResourceDto>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            tracing::error!("{e}");
            return Json(ResponseBase::err(400, "Invalid queue id."));
        }
    };
    let result = match service.get_queue_cache_info(id).await {
        Ok(el) => UpdateUsedResourceDto {
            allocated_memory: el.used.memory_used,
            allocated_cpu_count: el.used.core_number_used,
            used_storage: el.used.storage_capacity_used,
            queuing_task_count: el.task_count.queuing_task_count,
            running_task_count: el.task_count.running_task_count,
            used_node_count: el.used.node_number_used,
        },
        Err(e) => {
            tracing::error!("{e}");
            return Json(ResponseBase::err(500, "Interval error."));
        }
    };
    Json(ResponseBase::ok(Some(result)))
}
