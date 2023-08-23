use crate::prelude::*;
use std::ops::Range;

/// Transport file between local and server.
///
/// Each upload has a status cache record.
#[async_trait]
pub trait IStorageServerBrokerService {
    /// Transport local file to server, return stored file's url.
    async fn upload(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
        content: &[u8],
    ) -> AnyhowResult<ServerUrl>;

    /// Transport server file to local.
    async fn download(&self, storage_server: &StorageServer, meta_id: Uuid) -> Anyhow;

    /// Get file's download url.
    async fn get_download_url(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> AnyhowResult<String>;

    /// Get server file content into memory but not put it in local.
    async fn get_bytes(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> AnyhowResult<Vec<u8>>;

    /// Get server file content into string.
    async fn get_text(&self, storage_server: &StorageServer, meta_id: Uuid)
        -> AnyhowResult<String>;

    /// Get file rangely into memory.
    async fn rangely_get_file(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
        ranges: &[Range<u64>],
    ) -> AnyhowResult<Vec<Vec<u8>>>;

    /// Get file's size.
    async fn get_file_size(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> AnyhowResult<u64>;
}
