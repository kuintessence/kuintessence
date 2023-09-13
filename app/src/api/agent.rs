use super::{dtos::*, extract_uuid};
use crate::infrastructure::ServiceProvider;
use actix_web::{get, post, web};
use alice_di::{actix_auto_inject, IServiceProvider};
use alice_infrastructure::error::{
    AliceCommonError, AliceError, AliceResponder, AliceResponderResult,
};
use domain_workflow::{model::entity::Queue, service::QueueResourceService};
use std::sync::Arc;

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("agent/Register")]
pub async fn register(
    #[inject] service: Arc<dyn QueueResourceService>,
    data: web::Json<AgentRegisterDto>,
) -> AliceResponderResult<()> {
    let device_info =
        scoped_config
            .device_info
            .ok_or(AliceError::new(AliceCommonError::InternalError {
                source: anyhow::anyhow!("No device info in scoped config."),
            }))?;
    let name = device_info.preferred_username;
    let id = device_info.id;

    service
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
        .await?;

    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("agent/UpdateUsedResource")]
pub async fn update_used_resource(
    #[inject] service: Arc<dyn QueueResourceService>,
    data: web::Json<UpdateUsedResourceDto>,
) -> AliceResponderResult<()> {
    let device_info =
        scoped_config
            .device_info
            .ok_or(AliceError::new(AliceCommonError::InternalError {
                source: anyhow::anyhow!("No device info in scoped config."),
            }))?;
    let id = device_info.id;
    service.update_queue_resource(id, &data.0.into()).await;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("agent/GetQueueCacheInfo/{id}")]
pub async fn get_queue_cache_info(
    #[inject] service: Arc<dyn QueueResourceService>,
    id: web::Path<String>,
) -> AliceResponderResult<UpdateUsedResourceDto> {
    let id = extract_uuid(&id)?;
    let info = service.get_queue_cache_info(id).await?;
    let body = UpdateUsedResourceDto::from(info);
    Ok(AliceResponder(body))
}
