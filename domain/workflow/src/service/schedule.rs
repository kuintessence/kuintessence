use async_trait::async_trait;
use uuid::Uuid;

use crate::model::vo::msg::ChangeInfo;

#[async_trait]
/// Schedule target item with changed status or change status.
pub trait ScheduleService: Send + Sync {
    type Info: ChangeInfo;

    /// Handle a changed target item.
    async fn handle_changed(&self, id: String, info: Self::Info) -> anyhow::Result<()>;

    /// Change an target item.
    async fn change(&self, id: String, info: Self::Info) -> anyhow::Result<()>;
}
