use std::sync::Arc;

use async_trait::async_trait;
use domain_storage::{
    model::{
        entity::{FileMeta, FileStorage},
        vo::{
            record::{RecordFileMeta, RecordFileStorage},
            HashAlgorithm,
        },
    },
    repository::{FileMetaRepo, FileStorageRepo},
    service::MetaStorageService,
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct MetaStorageServiceImpl {
    meta_repo: Arc<dyn FileMetaRepo>,
    storage_repo: Arc<dyn FileStorageRepo>,
}

#[async_trait]
impl MetaStorageService for MetaStorageServiceImpl {
    async fn record_meta_and_storage(
        &self,
        meta_id: Uuid,
        file_meta_info: RecordFileMeta,
        file_storage_info: RecordFileStorage,
    ) -> anyhow::Result<()> {
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

        self.meta_repo.insert(&file_meta).await?;
        self.storage_repo.insert(&file_storage).await?;

        self.storage_repo.save_changed().await?;
        Ok(())
    }

    async fn satisfy_flash_upload(
        &self,
        hash: &str,
        hash_algorithm: &HashAlgorithm,
    ) -> anyhow::Result<Option<Uuid>> {
        if let Some(meta) = self.meta_repo.get_by_hash_and_algorithm(hash, hash_algorithm).await? {
            return Ok(Some(meta.id));
        }
        Ok(None)
    }

    async fn get_server_url(
        &self,
        storage_server_id: Uuid,
        meta_id: Uuid,
    ) -> anyhow::Result<String> {
        self.storage_repo
            .get_by_storage_server_id_and_meta_id(storage_server_id, meta_id)
            .await
    }
}
