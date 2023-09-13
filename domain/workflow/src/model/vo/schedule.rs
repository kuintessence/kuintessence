use uuid::Uuid;

pub enum ScheduleMode {
    WorkflowInstanceId(Uuid),
    NodeInstanceId(Uuid),
}
