use crate::prelude::*;

/// # Multipart file service
///
/// A multipart upload will generate local caches and a lease record,
/// when the parts are all uploaded and merged to one file, the local caches and record will be removed.
#[async_trait]
pub trait IMultipartService {
    /// Create multipart upload record with expire time in milliseconds.
    ///
    /// Error when a multipart with same meta_id or hash already exists.
    async fn create(
        &self,
        meta_id: Uuid,
        hash: &str,
        hash_algorithm: HashAlgorithm,
        count: usize,
    ) -> Anyhow;

    /// Complete a part.
    ///
    /// If the multipart is completed, it will validate hash, if passed, return merged cache file,
    /// else return None.
    async fn complete_part(&self, part: Part) -> AnyhowResult<Vec<usize>>;

    /// Get multipart info.
    async fn info(&self, meta_id: Uuid) -> AnyhowResult<Multipart>;

    /// Remove multipart upload.
    ///
    /// It will remove local caches and lease record.
    async fn remove(&self, meta_id: Uuid) -> Anyhow;
}

/// Part of the multipart.
pub struct Part {
    /// File meta id.
    pub meta_id: Uuid,
    /// Part content.
    pub content: Vec<u8>,
    /// Nth of the multipart.
    pub nth: usize,
}
