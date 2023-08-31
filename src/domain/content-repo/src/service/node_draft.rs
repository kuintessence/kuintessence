use async_trait::async_trait;
use uuid::Uuid;

use crate::model::vo::NodeDraft;

#[async_trait]
pub trait NodeDraftService: Send + Sync {
    async fn get_node_draft(
        &self,
        usecase_ver_id: Uuid,
        software_ver_id: Uuid,
    ) -> anyhow::Result<NodeDraft>;
}
