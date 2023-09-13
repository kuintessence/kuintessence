use anyhow::anyhow;
use async_trait::async_trait;
use domain_storage::{
    command::{CacheOperateCommand, CacheReadCommand},
    service::CacheService,
};
use std::path::{Path, PathBuf};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder, Clone)]
pub struct LocalCacheServiceImpl {
    #[builder(default = "base_dir".into(), setter(into))]
    base: PathBuf,
}

impl LocalCacheServiceImpl {
    fn normal_path(&self, meta_id: Uuid) -> PathBuf {
        self.base.join(format!("normal/{meta_id}"))
    }

    fn part_path(&self, meta_id: Uuid, nth: usize) -> PathBuf {
        self.base.join(format!("multipart/{meta_id}/{nth}"))
    }
    fn multipart_dir(&self, meta_id: Uuid) -> PathBuf {
        self.base.join(format!("multipart/{meta_id}"))
    }
    fn snapshot_path(&self, meta_id: Uuid) -> PathBuf {
        self.base.join(format!("snapshot/{meta_id}"))
    }
}
async fn create_parent_and_write(path: &Path, content: &[u8]) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&path.parent().ok_or(anyhow!("path: {path:?} doesn't has parent."))?)
        .await?;
    tokio::fs::write(path, content).await?;
    Ok(())
}
#[async_trait]
impl CacheService for LocalCacheServiceImpl {
    async fn operate(&self, cmd: CacheOperateCommand) -> anyhow::Result<()> {
        use CacheOperateCommand::*;
        match cmd {
            WriteNormal { meta_id, content } => {
                let path = self.normal_path(meta_id);
                create_parent_and_write(&path, &content).await?;
            }
            WritePart(part) => {
                let path = self.part_path(part.meta_id, part.nth);
                create_parent_and_write(&path, &part.content).await?;
            }
            RemoveMultipartDir { meta_id } => {
                let dir = self.multipart_dir(meta_id);
                tokio::fs::remove_dir_all(dir).await?;
            }
            RemoveNormal { meta_id } => {
                let path = self.normal_path(meta_id);
                tokio::fs::remove_file(path).await?;
            }
            ChangeNormalToSnapshot { meta_id } => {
                let normal_path = self.normal_path(meta_id);
                let snapshot_path = self.snapshot_path(meta_id);
                tokio::fs::create_dir_all(
                    &snapshot_path
                        .parent()
                        .ok_or(anyhow!("path: {snapshot_path:?} doesn't has parent."))?,
                )
                .await?;
                tokio::fs::rename(normal_path, snapshot_path).await?;
            }
            RemoveSnapshot { meta_id } => {
                let path = self.snapshot_path(meta_id);
                tokio::fs::remove_file(path).await?;
            }
            IsSnapshotExists { meta_id } => {
                let path = self.snapshot_path(meta_id);
                if !tokio::fs::try_exists(path).await? {
                    anyhow::bail!("Snapshot with meta_id: {meta_id} doesn't exists");
                }
            }
        };
        Ok(())
    }

    async fn read(&self, cmd: CacheReadCommand) -> anyhow::Result<Vec<u8>> {
        use CacheReadCommand::*;
        Ok(match cmd {
            ReadSnapshot { meta_id } => {
                let path = self.snapshot_path(meta_id);
                tokio::fs::read(path).await?
            }
            ReadPart { meta_id, nth } => {
                let path = self.part_path(meta_id, nth);
                tokio::fs::read(path).await?
            }
            ReadNormal { meta_id } => {
                let path = self.normal_path(meta_id);
                tokio::fs::read(path).await?
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use domain_storage::model::vo::Part;

    use super::*;
    use CacheOperateCommand::*;
    use CacheReadCommand::*;
    fn load() -> LocalCacheServiceImpl {
        LocalCacheServiceImpl::builder().build()
    }

    #[tokio::test]
    async fn write_part() {
        let service = load();
        let meta_id = Uuid::new_v4();

        let cmd0 = WritePart(Part {
            meta_id,
            content: b"123".to_vec(),
            nth: 0,
        });
        let cmd1 = WritePart(Part {
            meta_id,
            content: b"456".to_vec(),
            nth: 0,
        });
        service.operate(cmd0).await.unwrap();
        service.operate(cmd1).await.unwrap();
        let content = service.read(ReadPart { meta_id, nth: 0 }).await.unwrap();
        assert_eq!(b"456", content.as_slice());
        service.operate(RemoveMultipartDir { meta_id }).await.unwrap();
    }

    #[tokio::test]
    async fn snapshot() {
        let service = load();
        let meta_id = Uuid::new_v4();
        service
            .operate(WriteNormal {
                meta_id,
                content: b"789".to_vec(),
            })
            .await
            .unwrap();
        service.operate(ChangeNormalToSnapshot { meta_id }).await.unwrap();
        service.operate(IsSnapshotExists { meta_id }).await.unwrap();
        service.operate(RemoveSnapshot { meta_id }).await.unwrap();
    }
}
