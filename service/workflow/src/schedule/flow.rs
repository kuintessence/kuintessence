use async_trait::async_trait;
use domain_workflow::{model::vo::msg::FlowStatusChange, service::ScheduleService};
use uuid::Uuid;

pub struct FlowScheduleService {}

#[async_trait]
impl ScheduleService for FlowScheduleService {
    type Info = FlowStatusChange;

    async fn handle_changed(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        todo!()
    }

    async fn change(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        todo!()
    }
}
