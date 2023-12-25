use std::sync::Arc;

use actix_web::{web, HttpRequest, HttpResponse};
use alice_di::{actix_auto_inject, IServiceProvider};

use crate::infrastructure::{ServiceProvider, WsSessionOpener};
#[actix_auto_inject(ServiceProvider, scoped)]
pub async fn ws_handler(
    req: HttpRequest,
    body: web::Payload,
    #[inject] ws_opener: Arc<WsSessionOpener>,
) -> Result<HttpResponse, actix_web::Error> {
    tracing::info!("got websocket request");
    ws_opener.open_session(req, body).await
}
