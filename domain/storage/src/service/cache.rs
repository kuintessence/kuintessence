use async_trait::async_trait;

use crate::command::*;

/// # Local file manager Service.
///
/// Local file manager has a base path, and each file operation provides a relative path.
#[async_trait]
pub trait CacheService: Send + Sync {
    async fn operate(&self, cmd: CacheOperateCommand) -> anyhow::Result<()>;
    async fn read(&self, cmd: CacheReadCommand) -> anyhow::Result<Vec<u8>>;
}
