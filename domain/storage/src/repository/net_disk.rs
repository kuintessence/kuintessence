use alice_architecture::repository::DBRepository;
use async_trait::async_trait;
use uuid::Uuid;

use crate::model::entity::NetDisk;

#[async_trait]
pub trait NetDiskRepo: DBRepository<NetDisk> + Send + Sync {
    async fn get_root_id(&self) -> anyhow::Result<Option<Uuid>>;
    async fn get_flow_draft_dir_id(&self, flow_draft_id: Uuid) -> anyhow::Result<Option<Uuid>>;
    async fn get_node_instance_dir_id(&self, node_instance: Uuid) -> anyhow::Result<Option<Uuid>>;
    async fn get_flow_instance_dir_id(&self, flow_instance: Uuid) -> anyhow::Result<Option<Uuid>>;
    async fn get_flow_draft_root_id(&self) -> anyhow::Result<Option<Uuid>>;
    async fn get_flow_instance_root_id(&self) -> anyhow::Result<Option<Uuid>>;
    async fn is_same_pid_fname_exists(
        &self,
        parent_id: Option<Uuid>,
        file_name: &str,
    ) -> anyhow::Result<bool>;
    async fn create_root(&self) -> anyhow::Result<Uuid>;
}
