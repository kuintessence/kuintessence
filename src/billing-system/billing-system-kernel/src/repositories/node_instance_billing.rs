use crate::prelude::*;
use alice_architecture::repository::IDBRepository;

#[async_trait::async_trait]
pub trait INodeInstanceBillingRepository: IDBRepository<NodeInstanceBilling> {
    async fn get_all_by_flow_instance_id(
        &self,
        id: &str,
    ) -> anyhow::Result<Vec<NodeInstanceBilling>>;
}
