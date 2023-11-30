use async_trait::async_trait;
use uuid::Uuid;

use crate::exception::WorkflowResult;

#[async_trait]
pub trait ControlService {
    async fn submit(&self, draft_id: Uuid) -> WorkflowResult<Uuid>;

    async fn start(&self, instance_id: Uuid) -> WorkflowResult<()>;

    async fn pause(&self, instance_id: Uuid) -> WorkflowResult<()>;

    async fn resume(&self, instance_id: Uuid) -> WorkflowResult<()>;

    async fn terminate(&self, instance_id: Uuid) -> WorkflowResult<()>;

    async fn validate(&self, draft_id: Uuid)-> WorkflowResult<()>;
}
