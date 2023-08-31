use alice_architecture::utils::*;
use std::ops::Range;

/// Dispatch storage server operations to a certain storage server.
#[async_trait]
pub trait StorageServerDownloadDispatcherService: Send + Sync {
    /// Transport file to local.
    async fn download(&self, meta_id: Uuid) -> Anyhow;

    /// Get file content into memory but not put it in local.
    async fn get_bytes(&self, meta_id: Uuid) -> Anyhow<Vec<u8>>;

    /// Get file content into memory but not put it in local.
    async fn get_text(&self, meta_id: Uuid) -> Anyhow<String>;

    /// Get file rangely into memory.
    async fn rangely_get_file(&self, meta_id: Uuid, ranges: &[Range<u64>]) -> Anyhow<Vec<Vec<u8>>>;

    /// Get file's size.
    async fn get_file_size(&self, meta_id: Uuid) -> Anyhow<u64>;

    /// Get file's download url.
    async fn get_download_url(&self, meta_id: Uuid) -> Anyhow<String>;
}
