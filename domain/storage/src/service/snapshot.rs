use async_trait::async_trait;
use uuid::Uuid;

use crate::command::RequestSnapshotCommand;
use crate::model::entity::Snapshot;
use crate::model::vo::HashAlgorithm;

/// Snapshot record service.
///
/// Snapshot files are reused with same hash ones.
///
/// Snapshot is ident with node_id、file_id、timestamp.
///
/// When remove a snapshot, it will remove record first,
/// then look up if there is at least one same hash record exists,
/// if so, the snapshot file itself won't be removed until there is no snapshot using the file.
#[async_trait]
pub trait SnapshotService: Send + Sync {
    /// Send asynchronously message for a snapshot file, then the consumer will request server with created snapshot.
    async fn request(&self, info: RequestSnapshotCommand) -> anyhow::Result<()>;
    /// Create a snapshot record and create cache file.
    async fn create(&self, snapshot: Snapshot) -> anyhow::Result<()>;
    /// Create a snapshot record using exists cache file.
    async fn create_record(&self, snapshot: Snapshot) -> anyhow::Result<()>;
    /// Remove a snapshot.
    async fn remove(&self, id: Uuid) -> anyhow::Result<()>;
    /// Get a snapshot's content.
    async fn read(&self, id: Uuid) -> anyhow::Result<Vec<u8>>;
    /// Get snapshot records with node_id and file_id.
    async fn get_all_by_nid_and_fid(
        &self,
        node_id: Uuid,
        meta_id: Uuid,
    ) -> anyhow::Result<Vec<Snapshot>>;
    /// Judge whether the same hash snapshot is uploaded.
    async fn satisfy_flash_upload(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> anyhow::Result<Option<Uuid>>;
}
