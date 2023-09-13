use anyhow::{anyhow, bail};
use uuid::Uuid;
use std::sync::Arc;

use domain_storage::{
    command::{
        CacheOperateCommand::*, CacheReadCommand::*, CreateNetDiskFileCommand,
    },
    model::{
        entity::move_registration::MoveDestination,
        vo::record::{RecordFileMeta, RecordFileStorage},
    },
    service::*,
};
use typed_builder::TypedBuilder;

#[derive(TypedBuilder, Clone)]
pub struct FileUploadRunner {
    upload_service: Arc<dyn StorageServerUploadDispatcherService>,
    cache_service: Arc<dyn CacheService>,
    meta_storage_service: Arc<dyn MetaStorageService>,
    net_disk_service: Arc<dyn NetDiskService>,
    file_move_service: Arc<dyn FileMoveService>,
    multipart_service: Arc<dyn MultipartService>,
}

impl FileUploadRunner {
    pub async fn upload_file(&self, move_id: Uuid) -> anyhow::Result<()> {
        let mut move_info = self
            .file_move_service
            .get_move_info(move_id)
            .await?
            .ok_or(anyhow!("No such move info id: {move_id}"))?;

        let (meta_id, file_name, hash, hash_algorithm, size, record_net_disk) = (
            move_info.meta_id,
            move_info.file_name.to_owned(),
            move_info.hash.to_owned(),
            move_info.hash_algorithm.to_owned(),
            move_info.size,
            match move_info.destination {
                MoveDestination::StorageServer {
                    ref record_net_disk,
                } => record_net_disk.to_owned(),
                _ => bail!("Unreachable destination when run file upload."),
            },
        );
        let content = self.cache_service.read(ReadNormal { meta_id }).await?;
        let server_url = match self.upload_service.upload(meta_id, &content).await {
            Ok(el) => el,
            Err(e) => {
                move_info.is_upload_failed = true;
                move_info.failed_reason = Some(e.to_string());
                self.file_move_service.set_move_as_failed(move_id, &e.to_string()).await?;
                anyhow::bail!(format!(
                    "Error when upload file meta id: {meta_id} to server. - source: {e}"
                ))
            }
        };

        let (storage_server_id, server_url) =
            (server_url.storage_server_id, server_url.to_string());
        self.meta_storage_service
            .record_meta_and_storage(
                meta_id,
                RecordFileMeta {
                    name: file_name.to_owned(),
                    hash,
                    hash_algorithm,
                    size,
                },
                RecordFileStorage {
                    storage_server_id,
                    server_url,
                },
            )
            .await?;
        if let Some(el) = record_net_disk {
            let file_type = el.file_type.to_owned();
            let kind = el.kind.to_owned();
            self.net_disk_service
                .create_file(CreateNetDiskFileCommand {
                    meta_id,
                    file_name,
                    file_type,
                    kind,
                })
                .await?;
        }

        self.cache_service.operate(RemoveNormal { meta_id }).await?;
        self.multipart_service.remove(meta_id).await?;
        self.file_move_service.remove_all_with_meta_id(meta_id).await?;
        Ok(())
    }
}
