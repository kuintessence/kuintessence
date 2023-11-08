use async_trait::async_trait;
use domain_workflow::{
    model::{entity::workflow_instance::WorkflowInstanceStatus, vo::msg::StatusChange},
    service::ScheduleService,
};

pub struct FlowScheduleService {}

#[async_trait]
impl ScheduleService for FlowScheduleService {
    type Info = WorkflowInstanceStatus;

    /// Schedule with changed status.
    async fn handle_changed(&self, changed: StatusChange<Self::Info>) {
        todo!()
    }

    /// Change status.
    async fn change(&self, change: StatusChange<Self::Info>) {
        todo!()
    }
}
