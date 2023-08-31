//! Commands to interact with infrastructure

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Command to web socket server.
#[derive(Serialize, Deserialize)]
pub enum WsServerOperateCommand {
    /// Tell server to remove session (it must be closed)
    RemoveSession {
        /// Session id.
        id: Uuid,
    },

    /// Tell server to send message to session
    SendContentToSession {
        /// Session id.
        id: Uuid,
        /// Sending content.
        content: String,
    },
}
