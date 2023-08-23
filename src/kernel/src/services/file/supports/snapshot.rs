use crate::prelude::*;
use alice_architecture::IMessageQueueProducerTemplate;
use CacheOperateCommand::*;
use CacheReadCommand::*;

#[derive(Builder)]
pub struct SnapshotService {
    snapshot_repo: Arc<dyn ISnapshotRepo + Send + Sync>,
    mq_producer: Arc<dyn IMessageQueueProducerTemplate<RequestSnapshotCommand> + Send + Sync>,
    cache_service: Arc<dyn ICacheService + Send + Sync>,
    #[builder(default = "-1")]
    exp_msecs: i64,
    snapshot_topic: String,
}

fn complete_key(record: &Snapshot) -> String {
    let (id, node_id, file_id, timestamp, hash, hash_algorithm) = (
        record.id,
        record.node_id,
        record.file_id,
        record.timestamp,
        &record.hash,
        &record.hash_algorithm,
    );
    format!("snapshot_{id}_{node_id}_{file_id}_{timestamp}_{hash_algorithm}_{hash}")
}

fn id_key_regex(id: Uuid) -> String {
    format!("snapshot_{id}_*_*_*_*_*")
}

fn hash_key_regex(hash: &str, hash_algorithm: &HashAlgorithm) -> String {
    format!("snapshot_*_*_*_*_{hash_algorithm}_{hash}")
}

fn nid_fid_key_regex(node_id: Uuid, file_id: Uuid) -> String {
    format!("snapshot_*_{node_id}_{file_id}_*_*_*")
}

#[async_trait]
impl ISnapshotService for SnapshotService {
    async fn request(&self, info: RequestSnapshotCommand) -> Anyhow {
        self.mq_producer.send_object(&info, Some(&self.snapshot_topic)).await
    }

    async fn create(&self, snapshot: Snapshot) -> Anyhow {
        self.cache_service
            .operate(ChangeNormalToSnapshot {
                meta_id: snapshot.meta_id,
            })
            .await?;
        self.snapshot_repo
            .insert_with_lease(&complete_key(&snapshot), snapshot, self.exp_msecs)
            .await?;
        Ok(())
    }

    async fn create_record(&self, snapshot: Snapshot) -> Anyhow {
        self.snapshot_repo
            .insert_with_lease(&complete_key(&snapshot), snapshot, self.exp_msecs)
            .await?;
        Ok(())
    }

    async fn remove(&self, id: Uuid) -> anyhow::Result<()> {
        let deleted_record = self.snapshot_repo.delete_by_key_regex(&id_key_regex(id)).await?;
        let same_meta_id_snapshot = self
            .snapshot_repo
            .get_one_by_key_regex(&hash_key_regex(
                &deleted_record.hash,
                &deleted_record.hash_algorithm,
            ))
            .await?;
        if same_meta_id_snapshot.is_none() {
            // No more snapshot use the file, remove it. Otherwise  keep it.
            self.cache_service
                .operate(RemoveSnapshot {
                    meta_id: deleted_record.meta_id,
                })
                .await?;
        }
        Ok(())
    }

    async fn read(&self, id: Uuid) -> anyhow::Result<Vec<u8>> {
        let snapshot = self
            .snapshot_repo
            .get_one_by_key_regex(&id_key_regex(id))
            .await?
            .ok_or(anyhow!("No such snapshot with id: {id}"))?;
        self.cache_service
            .read(ReadSnapshot {
                meta_id: snapshot.meta_id,
            })
            .await
    }

    async fn get_all_by_nid_and_fid(
        &self,
        node_id: Uuid,
        meta_id: Uuid,
    ) -> anyhow::Result<Vec<Snapshot>> {
        self.snapshot_repo
            .get_all_by_key_regex(&nid_fid_key_regex(node_id, meta_id))
            .await
    }

    async fn satisfy_flash_upload(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> AnyhowResult<Option<Uuid>> {
        Ok(self
            .snapshot_repo
            .get_one_by_key_regex(&hash_key_regex(hash, hash_algorithm))
            .await?
            .map(|el| el.meta_id))
    }
}
