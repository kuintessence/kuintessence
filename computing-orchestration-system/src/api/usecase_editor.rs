use crate::infrastructure::ServiceProvider;
use actix_web::{post, web};
use alice_di::{actix_auto_inject, IServiceProvider};
use alice_infrastructure::error::{
    AliceCommonError, AliceError, AliceResponder, AliceResponderResult,
};
use domain_content_repo::{
    model::vo::{CommandPreview, TemplateKeys, ValidateData},
    service::ValidatePackageService,
};
use std::sync::Arc;

#[actix_auto_inject(ServiceProvider)]
#[post("usecase-editor/GetTemplateKeys")]
pub async fn get_template_keys(bytes: web::Bytes) -> AliceResponderResult<Vec<String>> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AliceError::new(AliceCommonError::InvalidRequest {
            error_description: "text contains not utf8 character.".to_string(),
        })
    })?;
    let TemplateKeys(keys) = text.parse::<TemplateKeys>()?;
    Ok(AliceResponder(keys))
}

#[actix_auto_inject(ServiceProvider)]
#[tracing::instrument(skip(sp))]
#[post("usecase-editor/PackageValidate")]
pub async fn package_validate(
    #[inject] validator: Arc<dyn ValidatePackageService>,
    data: web::Json<ValidateData>,
) -> AliceResponderResult<CommandPreview> {
    let data = data.0;
    let r = validator.validate_package(data).await?;
    Ok(AliceResponder(r))
}
