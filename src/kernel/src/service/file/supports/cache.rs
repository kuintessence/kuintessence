use crate::prelude::*;

/// # Local file manager Service.
///
/// Local file manager has a base path, and each file operation provides a relative path.
#[async_trait]
pub trait ICacheService {
    async fn operate(&self, cmd: CacheOperateCommand) -> Anyhow;
    async fn read(&self, cmd: CacheReadCommand) -> AnyhowResult<Vec<u8>>;

    // /// Create a local file.
    // async fn write(&self, cmd: CacheCommand) -> Anyhow;
    // /// Read a local file to Vec<u8>
    // async fn read(&self, cmd: CacheCommand) -> AnyhowResult<Vec<u8>>;
    // /// Remove a local file.
    // async fn remove_file(&self, cmd: CacheCommand) -> Anyhow;
    // /// Remove a local directory.
    // async fn remove_dir(&self, cmd: CacheCommand) -> Anyhow;
    // /// Change a local file to another purpose.
    // async fn change_purpose(&self, cmd: CacheCommand) -> Anyhow;
}

pub enum CacheOperateCommand {
    /// Whole file upload or complete multipart.
    WriteNormal { meta_id: Uuid, content: Vec<u8> },
    /// Complete a part of multipart.
    WritePart(Part),
    /// Remove multipart dir.
    RemoveMultipartDir { meta_id: Uuid },
    /// Remove normal file.
    RemoveNormal { meta_id: Uuid },
    /// Change normal file to snapshot file.
    ChangeNormalToSnapshot { meta_id: Uuid },
    /// Remove snapshot file.
    RemoveSnapshot { meta_id: Uuid },
    /// Ok if exists, else Err
    IsSnapshotExists { meta_id: Uuid },
}

pub enum CacheReadCommand {
    ReadNormal { meta_id: Uuid },
    ReadSnapshot { meta_id: Uuid },
    ReadPart { meta_id: Uuid, nth: usize },
}
