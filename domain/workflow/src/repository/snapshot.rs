use crate::SnapshotInfo;
use alice_architecture::repository::LeaseDBRepository;

#[async_trait::async_trait]
pub trait SnapshotRepository: LeaseDBRepository<SnapshotInfo> {
    async fn get_by_node_file_timestamp(
        &self,
        node_id: &str,
        file_id: &str,
        timestamp: i64,
    ) -> anyhow::Result<Option<SnapshotInfo>>;

    async fn delete_by_node_file_timestamp(
        &self,
        node_id: &str,
        file_id: &str,
        timestamp: i64,
    ) -> anyhow::Result<()>;
}
