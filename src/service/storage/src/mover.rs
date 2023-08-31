use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

use alice_architecture::utils::Anyhow;
use alice_architecture::GenericError::Specific as SpecificError;
use alice_architecture::IMessageQueueProducerTemplate;
use anyhow::anyhow;
use anyhow::bail;
use async_trait::async_trait;
use domain_storage::{
    command::{CreateNetDiskFileCommand, FileUploadCommand},
    exception::MoveException,
    model::entity::{
        move_registration::MoveDestination, net_disk::RecordNetDiskKind, MoveRegistration, Snapshot,
    },
    repository::MoveRegistrationRepo,
    service::*,
};
use domain_workflow::repository::WorkflowInstanceRepo;
use typed_builder::TypedBuilder;
use uuid::Uuid;
use MoveException::*;

#[derive(TypedBuilder)]
pub struct FileMoveServiceImpl {
    move_registration_repo: Arc<dyn MoveRegistrationRepo>,
    snapshot_service: Arc<dyn SnapshotService>,
    upload_sender_and_topic: (
        Arc<dyn IMessageQueueProducerTemplate<FileUploadCommand> + Send + Sync>,
        String,
    ),
    multipart_service: Arc<dyn MultipartService>,
    net_disk_service: Arc<dyn NetDiskService>,
    meta_storage_service: Arc<dyn MetaStorageService>,
    flow_instance_repo: Arc<dyn WorkflowInstanceRepo>,
    #[builder(default = 24 * 60 * 60 * 1000)]
    exp_msecs: i64,
}

fn key(move_id: Uuid, meta_id: Uuid) -> String {
    format!("movereg_{move_id}_{meta_id}")
}
fn meta_id_key_regex(meta_id: Uuid) -> String {
    format!("movereg_*_{meta_id}")
}
fn move_id_key_regex(move_id: Uuid) -> String {
    format!("movereg_{move_id}_*")
}

#[async_trait]
impl FileMoveService for FileMoveServiceImpl {
    async fn register_move(&self, info: MoveRegistration) -> Anyhow {
        let meta_id = info.meta_id;

        self.move_registration_repo
            .insert_with_lease(&key(info.id, meta_id), info, self.exp_msecs)
            .await?;

        Ok(())
    }

    async fn do_registered_moves(&self, meta_id: Uuid) -> Anyhow {
        let registrations = self
            .move_registration_repo
            .get_all_by_key_regex(&meta_id_key_regex(meta_id))
            .await?;
        for registration in registrations {
            let (move_id, meta_id, file_name, destination, hash, hash_algorithm, size, user_id) = (
                registration.id,
                registration.meta_id,
                registration.file_name,
                registration.destination,
                registration.hash,
                registration.hash_algorithm,
                registration.size,
                registration.user_id,
            );

            match destination {
                MoveDestination::Snapshot {
                    node_id,
                    timestamp,
                    file_id,
                } => {
                    self.snapshot_service
                        .create(Snapshot {
                            id: Uuid::new_v4(),
                            meta_id,
                            node_id,
                            file_id,
                            timestamp,
                            file_name,
                            size,
                            hash,
                            hash_algorithm,
                            user_id: user_id.ok_or(anyhow!("No user_id when insert snapshot"))?,
                        })
                        .await?;
                    self.multipart_service.remove(meta_id).await?;
                    self.move_registration_repo
                        .remove_all_by_key_regex(&meta_id_key_regex(meta_id))
                        .await?;
                }
                MoveDestination::StorageServer { .. } => {
                    let user_id = self
                        .get_user_id(move_id)
                        .await?
                        .ok_or(anyhow!("No such move_id:{move_id}"))?;
                    self.upload_sender_and_topic
                        .0
                        .send_object(
                            &FileUploadCommand { move_id, user_id },
                            Some(&self.upload_sender_and_topic.1),
                        )
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// Judge whether the file satisfies flash upload, and if so, do flash upload.
    ///
    /// When flash upload, return Err.
    async fn if_possible_do_flash_upload(&self, info: &MoveRegistration) -> Anyhow {
        let (old_meta_id, file_name, hash, hash_algorithm, destination, size, user_id) = (
            info.meta_id,
            &info.file_name,
            &info.hash,
            &info.hash_algorithm.to_owned(),
            &info.destination,
            info.size,
            info.user_id,
        );
        let already_id;
        match destination {
            MoveDestination::Snapshot {
                node_id,
                timestamp,
                file_id,
            } => {
                let meta_id =
                    self.snapshot_service.satisfy_flash_upload(hash, hash_algorithm).await?;
                if meta_id.is_none() {
                    return Ok(());
                }
                let meta_id = meta_id.unwrap();
                already_id = meta_id;
                self.snapshot_service
                    .create_record(Snapshot {
                        id: Uuid::new_v4(),
                        meta_id,
                        node_id: *node_id,
                        file_id: *file_id,
                        timestamp: *timestamp,
                        file_name: file_name.to_owned(),
                        size,
                        hash: hash.to_owned(),
                        hash_algorithm: hash_algorithm.to_owned(),
                        user_id: user_id.ok_or(anyhow!("No user_id when insert snapshot"))?,
                    })
                    .await?;
            }
            MoveDestination::StorageServer { record_net_disk } => {
                let meta_id =
                    self.meta_storage_service.satisfy_flash_upload(hash, hash_algorithm).await?;
                if meta_id.is_none() {
                    return Ok(());
                }
                let meta_id = meta_id.unwrap();
                already_id = meta_id;
                if let Some(el) = record_net_disk {
                    if let RecordNetDiskKind::NodeInstance { node_id } = el.kind {
                        let mut remaining_retry_times = 5;
                        loop {
                            let mut flow_instance =
                                self.flow_instance_repo.get_by_node_id(node_id).await?;
                            flow_instance
                                .update_node_instance_prepared_file_ids(old_meta_id, meta_id)?;

                            if self
                                .flow_instance_repo
                                .update_immediately_with_lock(flow_instance.clone())
                                .await
                                .is_ok()
                            {
                                break;
                            }

                            remaining_retry_times -= 1;
                            if remaining_retry_times == 0 {
                                bail!("Update flow instance spec retry failed!");
                            }
                            sleep(Duration::from_secs(1));
                        }
                    };
                    let file_type = el.file_type.to_owned();
                    let kind = el.kind.to_owned();
                    self.net_disk_service
                        .create_file(CreateNetDiskFileCommand {
                            meta_id,
                            file_name: file_name.to_owned(),
                            file_type,
                            kind,
                        })
                        .await?;
                }
            }
        }
        bail!(SpecificError(FlashUpload {
            destination: destination.to_string(),
            hash: hash.to_owned(),
            meta_id: old_meta_id,
            already_id
        }));
    }
    async fn set_all_moves_with_same_meta_id_as_failed(
        &self,
        meta_id: Uuid,
        failed_reason: &str,
    ) -> Anyhow {
        let mut infos = self
            .move_registration_repo
            .get_all_by_key_regex(&meta_id_key_regex(meta_id))
            .await?;
        infos.iter_mut().for_each(|el| {
            el.is_upload_failed = true;
            el.failed_reason = Some(failed_reason.to_owned())
        });
        for info in infos {
            self.move_registration_repo
                .update_with_lease(&key(info.id, meta_id), info, self.exp_msecs)
                .await?;
        }
        Ok(())
    }

    async fn set_move_as_failed(&self, move_id: Uuid, failed_reason: &str) -> Anyhow {
        let mut info = self
            .inner_get_move_info(move_id)
            .await?
            .ok_or(anyhow!("No such move with id: {move_id}"))?;

        info.is_upload_failed = true;
        info.failed_reason = Some(failed_reason.to_string());
        self.move_registration_repo
            .update_with_lease(&key(move_id, info.meta_id), info, self.exp_msecs)
            .await?;
        Ok(())
    }

    async fn get_move_info(&self, move_id: Uuid) -> Anyhow<Option<MoveRegistration>> {
        self.inner_get_move_info(move_id).await
    }

    async fn get_user_id(&self, move_id: Uuid) -> Anyhow<Option<Uuid>> {
        self.inner_get_user_id(move_id).await
    }

    async fn get_meta_id_failed_info(&self, meta_id: Uuid) -> Anyhow<(bool, Option<String>)> {
        let all = self
            .move_registration_repo
            .get_all_by_key_regex(&meta_id_key_regex(meta_id))
            .await?;
        let one = all.first().ok_or(anyhow!("No move info with meta_id: {meta_id}"))?;
        Ok((one.is_upload_failed, one.failed_reason.to_owned()))
    }

    async fn remove_all_with_meta_id(&self, meta_id: Uuid) -> Anyhow {
        self.move_registration_repo
            .remove_all_by_key_regex(&meta_id_key_regex(meta_id))
            .await
    }
}

impl FileMoveServiceImpl {
    async fn inner_get_move_info(&self, move_id: Uuid) -> Anyhow<Option<MoveRegistration>> {
        self.move_registration_repo
            .get_one_by_key_regex(&move_id_key_regex(move_id))
            .await
    }

    async fn inner_get_user_id(&self, move_id: Uuid) -> Anyhow<Option<Uuid>> {
        self.move_registration_repo
            .get_user_by_key_regex(&move_id_key_regex(move_id))
            .await
    }
}
