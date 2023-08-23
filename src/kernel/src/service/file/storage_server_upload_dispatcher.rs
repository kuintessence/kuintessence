use crate::prelude::*;

/// Dispatch storage server operations to a certain storage server.
#[async_trait]
pub trait IStorageServerUploadDispatcherService {
    /// Transport file to server, return stored file's url.
    async fn upload(&self, meta_id: Uuid, content: &[u8]) -> AnyhowResult<ServerUrl>;
}
