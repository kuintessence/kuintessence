use std::sync::Arc;

use actix_web::{post, web};
use alice_architecture::base_dto::ResponseBase;
use alice_di::{actix_auto_inject, IServiceProvider};
use domain_content_repo::{
    model::vo::{CommandPreview, TemplateKeys, ValidateData},
    service::ValidatePackageService,
};
use futures::StreamExt;

use crate::infrastructure::ServiceProvider;

#[actix_auto_inject(ServiceProvider)]
#[post("usecase-editor/GetTemplateKeys")]
pub async fn get_template_keys(mut body: web::Payload) -> web::Json<ResponseBase<Vec<String>>> {
    let mut bytes = web::BytesMut::new();
    while let Some(item) = body.next().await {
        let item = match item {
            Ok(x) => x,
            Err(e) => {
                tracing::error!("{e}");
                return web::Json(ResponseBase::err(400, &e.to_string()));
            }
        };
        bytes.extend_from_slice(&item);
    }
    match String::from_utf8(bytes.as_ref().to_owned()) {
        Ok(x) => match x.parse::<TemplateKeys>() {
            Ok(TemplateKeys(x)) => web::Json(ResponseBase::ok(Some(x))),
            Err(e) => {
                tracing::error!("{e}");
                web::Json(ResponseBase::err(400, &e.to_string()))
            }
        },
        Err(e) => {
            tracing::error!("{}", e);
            web::Json(ResponseBase::err(400, &e.to_string()))
        }
    }
}

#[actix_auto_inject(ServiceProvider)]
#[tracing::instrument(skip(sp))]
#[post("usecase-editor/PackageValidate")]
pub async fn package_validate(
    #[inject] validator: Arc<dyn ValidatePackageService>,
    data: web::Json<ValidateData>,
) -> actix_web::web::Json<ResponseBase<CommandPreview>> {
    let data = data.0;
    let response = match validator.validate_package(data).await {
        Ok(command_preview) => ResponseBase::new(200, "Pass Validate.", Some(command_preview)),
        Err(e) => {
            tracing::error!("{e}");
            ResponseBase::err(400, &e.to_string())
        }
    };
    web::Json(response)
}
