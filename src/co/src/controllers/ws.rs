use crate::infrastructure::ws::IWsManager;
use crate::infrastructure::ServiceProvider;
use actix_web::{web, Error, HttpRequest, HttpResponse};
use alice_di::{actix_auto_inject, IServiceProvider};
use std::sync::Arc;
use tokio::sync::Mutex;

#[actix_auto_inject(ServiceProvider)]
pub async fn ws_handler(req: HttpRequest, body: web::Payload) -> Result<HttpResponse, Error> {
    log::info!("got websocket request");
    let ws_manager: Arc<Mutex<dyn IWsManager + Send + Sync>> = sp.provide();
    ws_manager.clone().lock().await.open_session(req, body).await
}
