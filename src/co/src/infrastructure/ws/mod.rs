use actix_web::{web::Payload, HttpRequest, HttpResponse};
use kernel::prelude::*;
pub mod manager;
pub mod session;

/// A manager that manage different `web-socket` session between different client.
#[async_trait::async_trait(?Send)]
pub trait IWsManager {
    /// Send message to client session.
    async fn send_message(&mut self, id: Uuid, msg: &str) -> anyhow::Result<()>;
    /// Open client session.
    async fn open_session(
        &mut self,
        req: HttpRequest,
        body: Payload,
    ) -> Result<HttpResponse, actix_web::Error>;
}

/// A client `web-socket` session.
#[async_trait::async_trait(?Send)]
pub trait IWsSession {
    /// Start the client session.
    async fn start(
        &mut self,
        req: HttpRequest,
        body: Payload,
    ) -> Result<HttpResponse, actix_web::Error>;
    /// Send message to session.
    async fn send_message<T>(&mut self, msg: T) -> anyhow::Result<()>
    where
        T: Serialize + Send;
}
