use async_trait::async_trait;
use domain_workflow::{model::vo::msg::NodeChangeInfo, service::ScheduleService};
use uuid::Uuid;

pub struct NodeScheduleService {}

#[async_trait]
impl ScheduleService for NodeScheduleService {
    type Info = NodeChangeInfo;

    /// Handle a changed target item.
    async fn handle_changed(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        todo!()
    }

    /// Change an target item.
    async fn change(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        todo!()
    }
}
