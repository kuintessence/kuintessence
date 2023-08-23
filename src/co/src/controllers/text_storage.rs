use crate::infrastructure::ServiceProvider;
use actix_web::{post, web};
use alice_architecture::base_dto::ResponseBase;
use alice_di::actix_auto_inject;
use alice_di::IServiceProvider;
use kernel::prelude::*;

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[post("text-storage/Upload")]
pub async fn upload(
    #[inject] service: std::sync::Arc<dyn ITextStorageService + Send + Sync>,
    storage: web::Json<TextStorage>,
) -> web::Json<ResponseBase<String>> {
    let storage = storage.0;
    match service.upload_text(storage.to_owned()).await {
        Ok(x) => web::Json(alice_architecture::base_dto::ResponseBase::ok(Some(x))),
        Err(e) => {
            log::error!("{}", e);
            web::Json(alice_architecture::base_dto::ResponseBase::err(
                400, "Error",
            ))
        }
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[post("text-storage/GetByIds")]
pub async fn get_by_ids(
    #[inject] service: std::sync::Arc<dyn ITextStorageService + Send + Sync>,
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
            log::error!("{e}");
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
#[alice_web_macro::message_consumer]
pub async fn upload_text(
    #[serialize] input: TextStorage,
    #[inject] service: std::sync::Arc<dyn ITextStorageService + Send + Sync>,
) -> anyhow::Result<()> {
    service.upload_text(input).await?;
    Ok(())
}
