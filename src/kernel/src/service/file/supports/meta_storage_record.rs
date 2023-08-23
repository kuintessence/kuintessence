use crate::prelude::*;

/// Record file_metadata and file_storage.
#[async_trait]
pub trait IMetaStorageService {
    /// Record uploaded file into file_metadata and file_storage.
    async fn record_meta_and_storage(
        &self,
        meta_id: Uuid,
        file_meta_info: RecordFileMeta,
        file_storage_info: RecordFileStorage,
        user_id: Option<Uuid>,
    ) -> Anyhow;
    /// Look up file_metadata to judge whether the same hash file is uploaded.
    /// If satisfy, return meta_id.
    async fn satisfy_flash_upload(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> AnyhowResult<Option<Uuid>>;
    /// Get server_url by storage_server_id and meta_id.
    async fn get_server_url(&self, storage_server_id: Uuid, meta_id: Uuid) -> AnyhowResult<String>;
}

pub struct RecordFileMeta {
    pub name: String,
    pub hash: String,
    pub hash_algorithm: HashAlgorithm,
    pub size: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordFileStorage {
    pub storage_server_id: Uuid,
    pub server_url: String,
}
