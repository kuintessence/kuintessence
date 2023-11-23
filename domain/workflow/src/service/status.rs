use async_trait::async_trait;

use crate::model::vo::msg::{ChangeMsg, TaskChangeInfo};

#[async_trait]
pub trait StatusService {
    async fn handle(&self, msg: ChangeMsg) -> anyhow::Result<()>;
}
