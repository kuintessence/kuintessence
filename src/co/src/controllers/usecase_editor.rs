use crate::infrastructure::ServiceProvider;
use actix_web::{
    get, post,
    web::{self, Json, Query},
};
use alice_architecture::base_dto::ResponseBase;
use alice_di::{actix_auto_inject, IServiceProvider};
use lib_co_repo::{
    client::IInfoGetter, models::command_preview::CommandPreview,
    services::package_validate::ValidateData,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[actix_auto_inject(ServiceProvider)]
#[tracing::instrument(skip(sp))]
#[get("usecase-editor/GetTemplateKeys")]
pub async fn get_template_keys(
    #[inject] client: Arc<dyn IInfoGetter + Send + Sync>,
    request: Query<GetTemplateKeysRequest>,
) -> web::Json<ResponseBase<Vec<String>>> {
    match client.get_template_keys(request.source.as_str()).await {
        Ok(x) => web::Json(ResponseBase::ok(Some(x))),
        Err(e) => {
            log::error!("{}", e);
            web::Json(ResponseBase::err(400, &e.to_string()))
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GetTemplateKeysRequest {
    source: String,
}

#[actix_auto_inject(ServiceProvider)]
#[tracing::instrument(skip(sp))]
#[post("usecase-editor/PackageValidate")]
pub async fn package_validate(
    #[inject] client: Arc<dyn IInfoGetter + Send + Sync>,
    data: web::Json<ValidateData>,
) -> actix_web::web::Json<ResponseBase<CommandPreview>> {
    let data = data.0;
    let response = match client.package_validate(data).await {
        Ok(command_preview) => ResponseBase::new(200, "Pass Validate.", Some(command_preview)),
        Err(e) => {
            log::error!("{e}");
            ResponseBase::err(400, &e.to_string())
        }
    };
    Json(response)
}
