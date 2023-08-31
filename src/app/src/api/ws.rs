use std::sync::Arc;

use actix_web::{web, Error, HttpRequest, HttpResponse};
use alice_di::{actix_auto_inject, IServiceProvider};

use crate::infrastructure::{ServiceProvider, WsManager};

#[actix_auto_inject(ServiceProvider)]
pub async fn ws_handler(req: HttpRequest, body: web::Payload) -> Result<HttpResponse, Error> {
    tracing::info!("got websocket request");
    let ws_manager: Arc<WsManager> = sp.provide();
    ws_manager.clone().open_session(req, body).await
}
