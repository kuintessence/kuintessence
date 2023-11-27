use async_trait::async_trait;
use uuid::Uuid;

use crate::model::entity::{node_instance::NodeInstanceKind, workflow_instance::NodeSpec};

#[async_trait]
/// Usecase handler
pub trait UsecaseParseService: Send + Sync {
    /// Provide node spec, it will generate tasks and persistence them.
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()>;

    fn get_service_type(&self) -> NodeInstanceKind;

    async fn get_cmd(&self, node_id: Uuid) -> anyhow::Result<Option<String>>;
}

#[async_trait]
/// Usecase handler selector
pub trait UsecaseSelectService: Send + Sync {
    /// Send the node spec to its handler.
    async fn send_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()>;
}
