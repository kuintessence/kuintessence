use crate::SnapshotInfo;
use alice_architecture::repository::ILeaseDBRepository;

#[async_trait::async_trait]
pub trait SnapshotRepository: ILeaseDBRepository<SnapshotInfo> {
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
