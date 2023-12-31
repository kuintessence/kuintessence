use async_trait::async_trait;
use uuid::Uuid;

use crate::model::vo::ServerUrl;

/// Dispatch storage server operations to a certain storage server.
#[async_trait]
pub trait StorageServerUploadDispatcherService: Send + Sync {
    /// Transport file to server, return stored file's url.
    async fn upload(&self, meta_id: Uuid, content: &[u8]) -> anyhow::Result<ServerUrl>;
}
