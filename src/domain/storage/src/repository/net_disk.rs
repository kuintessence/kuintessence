use alice_architecture::utils::*;
use alice_architecture::IDBRepository;

use crate::model::entity::NetDisk;

#[async_trait]
pub trait NetDiskRepo: IDBRepository<NetDisk> + Send + Sync {
    async fn get_root_id(&self, user_id: Option<Uuid>) -> Anyhow<Option<Uuid>>;
    async fn get_flow_draft_dir_id(&self, flow_draft_id: Uuid) -> Anyhow<Option<Uuid>>;
    async fn get_node_instance_dir_id(&self, node_instance: Uuid) -> Anyhow<Option<Uuid>>;
    async fn get_flow_instance_dir_id(&self, flow_instance: Uuid) -> Anyhow<Option<Uuid>>;
    async fn get_flow_draft_root_id(&self) -> Anyhow<Option<Uuid>>;
    async fn get_flow_instance_root_id(&self, user_id: Option<Uuid>) -> Anyhow<Option<Uuid>>;
    async fn is_same_pid_fname_exists(
        &self,
        parent_id: Option<Uuid>,
        file_name: &str,
        user_id: Option<Uuid>,
    ) -> Anyhow<bool>;
    async fn create_root(&self) -> Anyhow<Uuid>;
}
