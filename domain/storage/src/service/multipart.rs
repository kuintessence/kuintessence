use async_trait::async_trait;
use uuid::Uuid;

use crate::exception::FileResult;
use crate::model::entity::Multipart;
use crate::model::vo::{HashAlgorithm, Part};

/// # Multipart file service
///
/// A multipart upload will generate local caches and a lease record,
/// when the parts are all uploaded and merged to one file, the local caches and record will be removed.
#[async_trait]
pub trait MultipartService: Send + Sync {
    /// Create multipart upload record with expire time in milliseconds.
    ///
    /// Error when a multipart with same meta_id or hash already exists.
    async fn create(
        &self,
        meta_id: Uuid,
        hash: &str,
        hash_algorithm: HashAlgorithm,
        count: usize,
    ) -> FileResult<()>;

    /// Complete a part.
    ///
    /// If the multipart is completed, it will validate hash, if passed, return merged cache file,
    /// else return None.
    async fn complete_part(&self, part: Part) -> FileResult<Vec<usize>>;

    /// Get multipart info.
    async fn info(&self, meta_id: Uuid) -> FileResult<Multipart>;

    /// Remove multipart upload.
    ///
    /// It will remove local caches and lease record.
    async fn remove(&self, meta_id: Uuid) -> FileResult<()>;
}
