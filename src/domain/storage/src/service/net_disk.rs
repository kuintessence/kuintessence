use crate::command::CreateNetDiskFileCommand;
use alice_architecture::utils::*;

/// Net disk service.
///
/// All same name file in same directory will upload their last_modified_time when they have the same hash,
///
/// and will create new file name with the hash suffix when the hash is different.
#[async_trait]
pub trait NetDiskService: Send + Sync {
    /// Create net disk file.
    async fn create_file(&self, command: CreateNetDiskFileCommand) -> Anyhow;
}
