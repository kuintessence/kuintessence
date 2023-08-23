use crate::prelude::*;
use alice_architecture::IDBRepository;

#[async_trait]
pub trait INetDiskRepo: IDBRepository<NetDisk> {
    async fn get_root_id(&self, user_id: Option<Uuid>) -> AnyhowResult<Option<Uuid>>;
    async fn get_flow_draft_dir_id(&self, flow_draft_id: Uuid) -> AnyhowResult<Option<Uuid>>;
    async fn get_node_instance_dir_id(&self, node_instance: Uuid) -> AnyhowResult<Option<Uuid>>;
    async fn get_flow_instance_dir_id(&self, flow_instance: Uuid) -> AnyhowResult<Option<Uuid>>;
    async fn get_flow_draft_root_id(&self) -> AnyhowResult<Option<Uuid>>;
    async fn get_flow_instance_root_id(&self, user_id: Option<Uuid>) -> AnyhowResult<Option<Uuid>>;
    async fn is_same_pid_fname_exists(
        &self,
        parent_id: Option<Uuid>,
        file_name: &str,
        user_id: Option<Uuid>,
    ) -> AnyhowResult<bool>;
    async fn create_root(&self) -> AnyhowResult<Uuid>;
}
