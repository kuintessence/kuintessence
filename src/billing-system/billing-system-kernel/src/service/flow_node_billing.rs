use crate::prelude::*;

#[async_trait::async_trait]
pub trait IFlowNodeBillingService {
    /// 获取工作流节点计费信息
    async fn get_bill(
        &self,
        flow_instance_id: &str,
    ) -> anyhow::Result<(FlowInstanceBilling, Vec<NodeInstanceBilling>)>;
    /// 记录工作流节点计费信息
    async fn record_bill(&self, node_instance_id: &str) -> anyhow::Result<()>;
}
