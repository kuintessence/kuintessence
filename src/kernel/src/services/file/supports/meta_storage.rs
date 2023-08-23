use crate::prelude::*;

#[derive(Builder)]
pub struct MetaStorageService {
    meta_repo: Arc<dyn IFileMetaRepo + Send + Sync>,
    storage_repo: Arc<dyn IFileStorageRepo + Send + Sync>,
}

#[async_trait]
impl IMetaStorageService for MetaStorageService {
    async fn record_meta_and_storage(
        &self,
        meta_id: Uuid,
        file_meta_info: RecordFileMeta,
        file_storage_info: RecordFileStorage,
        user_id: Option<Uuid>,
    ) -> Anyhow {
        let file_meta = FileMeta {
            id: meta_id,
            name: file_meta_info.name,
            hash: file_meta_info.hash,
            hash_algorithm: file_meta_info.hash_algorithm,
            size: file_meta_info.size,
        };
        let file_storage = FileStorage {
            storage_server_id: file_storage_info.storage_server_id,
            meta_id,
            server_url: file_storage_info.server_url,
        };

        self.meta_repo.insert(file_meta).await?;
        match user_id {
            Some(el) => {
                self.storage_repo.insert_with_custom_user_id(file_storage, el).await?;
            }
            None => {
                self.storage_repo.insert(file_storage).await?;
            }
        }

        self.storage_repo.save_changed().await?;
        Ok(())
    }

    async fn satisfy_flash_upload(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> AnyhowResult<Option<Uuid>> {
        if let Some(meta) = self.meta_repo.get_by_hash_and_algorithm(hash, hash_algorithm).await? {
            return Ok(Some(meta.id));
        }
        Ok(None)
    }

    async fn get_server_url(&self, storage_server_id: Uuid, meta_id: Uuid) -> AnyhowResult<String> {
        self.storage_repo
            .get_by_storage_server_id_and_meta_id(storage_server_id, meta_id)
            .await
    }
}
