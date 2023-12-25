use crate::api::dtos::GetTextByIdResponse;
use crate::infrastructure::ServiceProvider;
use actix_web::{post, web};
use alice_di::actix_auto_inject;
use alice_di::IServiceProvider;
use alice_infrastructure::error::AliceResponder;
use alice_infrastructure::error::AliceResponderResult;
use domain_storage::model::entity::TextStorage;
use domain_storage::service::TextStorageService;
use uuid::Uuid;

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("text-storage/Upload")]
pub async fn upload(
    #[inject] service: std::sync::Arc<dyn TextStorageService>,
    storage: web::Json<TextStorage>,
) -> AliceResponderResult<Uuid> {
    let storage = storage.0;
    let key = service.upload_text(storage.to_owned()).await?;
    Ok(AliceResponder(key))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("text-storage/GetByIds")]
pub async fn get_by_ids(
    #[inject] service: std::sync::Arc<dyn TextStorageService>,
    keys: web::Json<Vec<Uuid>>,
) -> AliceResponderResult<Vec<GetTextByIdResponse>> {
    let keys = keys.0;
    let r = service
        .get_by_ids(&keys)
        .await?
        .iter()
        .map(|(k, v)| GetTextByIdResponse {
            key: k.to_string(),
            value: v.to_owned(),
        })
        .collect::<Vec<_>>();
    Ok(AliceResponder(r))
}
