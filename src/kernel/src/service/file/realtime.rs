use crate::prelude::*;

/// Handle realtime file interaction.
#[async_trait]
pub trait IRealtimeService {
    /// Request for realtime file.
    async fn request_realtime_file(&self, client_id: Uuid, cmd: ViewRealtimeCommand) -> Anyhow;
    /// Send realtime file to ws session client coresponding to request_id.
    async fn send_realtime(&self, request_id: Uuid, file_content: &str) -> Anyhow;
}
