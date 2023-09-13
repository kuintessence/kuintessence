
use actix_web::web::Payload;
use actix_web::{HttpRequest, HttpResponse};
use alice_infrastructure::error::AliceError;
use anyhow::anyhow;
use std::sync::Arc;
use uuid::Uuid;

use crate::infrastructure::WsManager;


pub struct WsSessionOpener {
    ws_manager: Arc<WsManager>,
    user_id: Option<Uuid>,
}

impl WsSessionOpener {
    pub fn new(ws_manager: Arc<WsManager>, user_id: Option<Uuid>) -> Self {
        Self {
            ws_manager,
            user_id,
        }
    }

    fn user_id(&self) -> anyhow::Result<Uuid> {
        self.user_id.ok_or(anyhow!("No user id when ws opener use it."))
    }

    pub async fn open_session(
        &self,
        req: HttpRequest,
        body: Payload,
    ) -> actix_web::error::Result<HttpResponse> {
        self.ws_manager
            .open_session(req, body, self.user_id().map_err(AliceError::from)?)
            .await
    }
}
