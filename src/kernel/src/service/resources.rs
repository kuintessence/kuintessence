use crate::prelude::*;

/// Manage regions, avz(available zone)s, servers and clusters.
#[async_trait]
pub trait IResourcesService {
    /// Get co system default storage server.
    async fn default_file_storage_server(&self) -> AnyhowResult<StorageServer>;
}
