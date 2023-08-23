use kernel::prelude::*;
use CacheOperateCommand::*;
use CacheReadCommand::*;

#[async_trait]
pub trait IFileUploadRunner {
    async fn upload_file(&self, cmd: FileUploadCommand) -> Anyhow;
}

#[derive(Builder, Clone)]
pub struct FileUploadRunner {
    upload_service: Arc<dyn IStorageServerUploadDispatcherService + Send + Sync>,
    cache_service: Arc<dyn ICacheService + Send + Sync>,
    meta_storage_service: Arc<dyn IMetaStorageService + Send + Sync>,
    net_disk_service: Arc<dyn INetDiskService + Send + Sync>,
    file_move_service: Arc<dyn IFileMoveService + Send + Sync>,
    multipart_service: Arc<dyn IMultipartService + Send + Sync>,
}

#[async_trait]
impl IFileUploadRunner for FileUploadRunner {
    async fn upload_file(&self, cmd: FileUploadCommand) -> Anyhow {
        let move_id = cmd.move_id;
        let mut move_info = self
            .file_move_service
            .get_move_info(move_id)
            .await?
            .ok_or(anyhow!("No such move info id: {move_id}"))?;

        let user_id = self
            .file_move_service
            .get_user_id(move_id)
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
            (server_url.storage_server_id, server_url.server_url());
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
                Some(user_id),
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
