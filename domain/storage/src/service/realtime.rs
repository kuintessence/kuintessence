use async_trait::async_trait;

use crate::command::ViewRealtimeCommand;

/// Handle realtime file interaction.
#[async_trait]
pub trait RealtimeService: Send + Sync {
    /// Request for realtime file.
    async fn request_realtime_file(&self, cmd: ViewRealtimeCommand) -> anyhow::Result<()>;
    /// Send realtime file to ws session client coresponding to request_id.
    async fn responde_realtime(&self, file_content: &str) -> anyhow::Result<()>;
}
