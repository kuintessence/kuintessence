use std::sync::Arc;

use crate::infrastructure::ServiceProvider;
use actix_web::{post, web};
use alice_architecture::base_dto::ResponseBase;
use alice_architecture::utils::*;
use alice_di::actix_auto_inject;
use alice_di::IServiceProvider;
use domain_storage::{model::entity::TextStorage, service::TextStorageService};

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web::http_request]
#[alice_web::authorize]
#[post("text-storage/Upload")]
pub async fn upload(
    #[inject] service: Arc<dyn TextStorageService>,
    storage: web::Json<TextStorage>,
) -> web::Json<ResponseBase<String>> {
    let storage = storage.0;
    match service.upload_text(storage.to_owned()).await {
        Ok(x) => web::Json(alice_architecture::base_dto::ResponseBase::ok(Some(x))),
        Err(e) => {
            tracing::error!("{}", e);
            web::Json(alice_architecture::base_dto::ResponseBase::err(
                400, "Error",
            ))
        }
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web::http_request]
#[alice_web::authorize]
#[post("text-storage/GetByIds")]
pub async fn get_by_ids(
    #[inject] service: Arc<dyn TextStorageService>,
    keys: web::Json<Vec<Uuid>>,
) -> web::Json<ResponseBase<Vec<GetTextByIdResponse>>> {
    let keys = keys.0;
    match service.get_by_ids(&keys).await {
        Ok(x) => web::Json(alice_architecture::base_dto::ResponseBase::ok(Some(
            x.iter()
                .map(|(k, v)| GetTextByIdResponse {
                    key: k.to_string(),
                    value: v.to_owned(),
                })
                .collect::<Vec<_>>(),
        ))),
        Err(e) => {
            tracing::error!("{e}");
            web::Json(alice_architecture::base_dto::ResponseBase::err(
                400, "Error",
            ))
        }
    }
}

#[derive(Serialize)]
pub struct GetTextByIdResponse {
    pub key: String,
    pub value: String,
}

#[alice_di::auto_inject(ServiceProvider, scoped = "None")]
#[alice_web::message_consumer]
pub async fn upload_text(
    #[serialize] input: TextStorage,
    #[inject] service: Arc<dyn TextStorageService>,
) -> anyhow::Result<()> {
    service.upload_text(input).await?;
    Ok(())
}
