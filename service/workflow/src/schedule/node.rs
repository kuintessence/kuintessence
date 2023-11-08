use async_trait::async_trait;
use domain_workflow::{
    model::{entity::node_instance::NodeInstanceStatus, vo::msg::StatusChange},
    service::ScheduleService,
};

pub struct NodeScheduleService {}

#[async_trait]
impl ScheduleService for NodeScheduleService {
    type Info = NodeInstanceStatus;

    /// Schedule with changed status.
    async fn handle_changed(&self, changed: StatusChange<Self::Info>) {
        todo!()
    }

    /// Change status.
    async fn change(&self, change: StatusChange<Self::Info>) {
        todo!()
    }
}
