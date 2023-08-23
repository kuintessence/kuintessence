use crate::prelude::*;
use std::ops::Range;

/// The relative file storted url on the server.
pub struct ServerUrl {
    pub bucket: String,
    pub storage_server_id: Uuid,
    pub meta_id: Uuid,
}

impl ServerUrl {
    pub fn key(&self) -> String {
        format!("storage-{}/{}", self.storage_server_id, self.meta_id)
    }
    pub fn server_url(&self) -> String {
        format!("{}/{}", self.bucket, self.key())
    }
}

/// Dispatch storage server operations to a certain storage server.
#[async_trait]
pub trait IStorageServerDownloadDispatcherService {
    /// Transport file to local.
    async fn download(&self, meta_id: Uuid) -> Anyhow;

    /// Get file content into memory but not put it in local.
    async fn get_bytes(&self, meta_id: Uuid) -> AnyhowResult<Vec<u8>>;

    /// Get file content into memory but not put it in local.
    async fn get_text(&self, meta_id: Uuid) -> AnyhowResult<String>;

    /// Get file rangely into memory.
    async fn rangely_get_file(
        &self,
        meta_id: Uuid,
        ranges: &[Range<u64>],
    ) -> AnyhowResult<Vec<Vec<u8>>>;

    /// Get file's size.
    async fn get_file_size(&self, meta_id: Uuid) -> AnyhowResult<u64>;

    /// Get file's download url.
    async fn get_download_url(&self, meta_id: Uuid) -> AnyhowResult<String>;
}
