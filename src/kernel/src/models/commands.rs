use crate::prelude::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUploadCommand {
    pub move_id: Uuid,
    pub user_id: Uuid,
}

/// Command to web socket server.
#[derive(Serialize, Deserialize)]
pub enum WsServerOperateCommand {
    /// Tell server to close web socket client session.
    CloseSession {
        /// Client id.
        client_id: Uuid,
    },
    /// Tell server to send message to client session.
    SendContentToSession {
        /// Client id.
        client_id: Uuid,
        /// Sending content.
        content: String,
    },
}

/// View realtime file message.
#[derive(Serialize, Deserialize, Builder)]
#[serde(rename_all = "camelCase")]
pub struct ViewRealtimeCommand {
    #[serde(skip_deserializing)]
    pub req_id: Uuid,
    #[serde(rename = "nodeInstanceId")]
    pub node_id: Uuid,
    #[serde(rename = "fileMetadataId")]
    pub meta_id: Uuid,
    pub start_row: i64,
    pub rows_per_page: i64,
    pub regex: String,
}

/// Request snapshot command.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RequestSnapshotCommand {
    /// node id
    pub node_id: Uuid,
    /// file id
    pub file_id: Uuid,
    /// timestamp
    pub timestamp: i64,
}
