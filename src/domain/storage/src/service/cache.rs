use crate::command::*;
use alice_architecture::utils::*;

/// # Local file manager Service.
///
/// Local file manager has a base path, and each file operation provides a relative path.
#[async_trait]
pub trait CacheService: Send + Sync {
    async fn operate(&self, cmd: CacheOperateCommand) -> Anyhow;
    async fn read(&self, cmd: CacheReadCommand) -> Anyhow<Vec<u8>>;

    // /// Create a local file.
    // async fn write(&self, cmd: CacheCommand) -> Anyhow;
    // /// Read a local file to Vec<u8>
    // async fn read(&self, cmd: CacheCommand) -> Anyhow<Vec<u8>>;
    // /// Remove a local file.
    // async fn remove_file(&self, cmd: CacheCommand) -> Anyhow;
    // /// Remove a local directory.
    // async fn remove_dir(&self, cmd: CacheCommand) -> Anyhow;
    // /// Change a local file to another purpose.
    // async fn change_purpose(&self, cmd: CacheCommand) -> Anyhow;
}
