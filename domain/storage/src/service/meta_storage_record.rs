use async_trait::async_trait;
use uuid::Uuid;

use crate::model::vo::{HashAlgorithm, RecordFileMeta, RecordFileStorage};

/// Record file_metadata and file_storage.
#[async_trait]
pub trait MetaStorageService: Send + Sync {
    /// Record uploaded file into file_metadata and file_storage.
    async fn record_meta_and_storage(
        &self,
        meta_id: Uuid,
        file_meta_info: RecordFileMeta,
        file_storage_info: RecordFileStorage,
    ) -> anyhow::Result<()>;

    /// Look up file_metadata to judge whether the same hash file is uploaded.
    /// If satisfy, return meta_id.
    async fn satisfy_flash_upload(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> anyhow::Result<Option<Uuid>>;

    /// Get server_url by storage_server_id and meta_id.
    async fn get_server_url(
        &self,
        storage_server_id: Uuid,
        meta_id: Uuid,
    ) -> anyhow::Result<String>;
}
