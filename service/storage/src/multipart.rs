use std::{sync::Arc, thread::sleep, time::Duration};

use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use anyhow::Context;
use async_trait::async_trait;
use domain_storage::{
    command::{CacheOperateCommand, CacheReadCommand},
    exception::{FileException, FileResult},
    model::{
        entity::Multipart,
        vo::{HashAlgorithm, Part},
    },
    repository::{MoveRegistrationRepo, MultipartRepo},
    service::{CacheService, MultipartService},
};
use domain_workflow::model::vo::msg::{ChangeMsg, Info, TaskChangeInfo, TaskStatusChange};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct MultipartServiceImpl {
    multipart_repo: Arc<dyn MultipartRepo>,
    cache_service: Arc<dyn CacheService>,
    #[builder(default = 24 * 60 * 60 * 1000)]
    exp_msecs: i64,
    move_registration_repo: Arc<dyn MoveRegistrationRepo>,
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
    task_id: Option<Uuid>,
}

fn id_hash_key(id: Uuid, hash: &str) -> String {
    format!("multipart_{id}_{hash}")
}

fn id_key_regex(id: Uuid) -> String {
    format!("multipart_{id}_*")
}

fn hash_key_regex(hash: &str) -> String {
    format!("multipart_*_{hash}")
}

fn move_meta_id_key_regex(meta_id: Uuid) -> String {
    format!("movereg_*_{meta_id}")
}

#[async_trait]
impl MultipartService for MultipartServiceImpl {
    async fn create(
        &self,
        meta_id: Uuid,
        hash: &str,
        hash_algorithm: HashAlgorithm,
        count: u64,
    ) -> FileResult<()> {
        let hash = hash.to_uppercase();
        // Test is hash the same.
        let same_hash = self.multipart_repo.get_one_by_key_regex(&hash_key_regex(&hash)).await?;
        if let Some(el) = same_hash {
            return Err(FileException::ConflictedHash {
                meta_id: el.meta_id,
                hash: hash.to_owned(),
            });
        };

        // If hash isn't same, but id conflict, it is an error.
        let same_id = self.multipart_repo.get_one_by_key_regex(&id_key_regex(meta_id)).await?;
        if same_id.is_some() {
            return Err(FileException::ConflictedId { meta_id });
        };

        let multipart = Multipart {
            meta_id,
            hash: hash.to_owned(),
            hash_algorithm,
            shards: (0..count).collect(),
            part_count: count,
            last_update_timestamp: chrono::Utc::now().timestamp_micros(),
        };
        self.multipart_repo
            .insert_with_lease(&id_hash_key(meta_id, &hash), &multipart, self.exp_msecs)
            .await?;
        Ok(())
    }

    async fn complete_part(&self, part: Part) -> FileResult<Vec<u64>> {
        let meta_id = part.meta_id;
        let nth = part.nth;
        let content = part.content;
        // Cache part
        self.cache_service
            .operate(CacheOperateCommand::WritePart(Part {
                meta_id,
                content,
                nth,
            }))
            .await?;

        // Add lock.
        let mut remaining_retries = 5;
        let multipart = loop {
            let mut multipart = self
                .multipart_repo
                .get_one_by_key_regex(&id_key_regex(meta_id))
                .await?
                .ok_or(FileException::MultipartNotFound { meta_id })?;
            multipart.shards.retain(|c| !c.eq(&nth));

            let multipart_now = self
                .multipart_repo
                .get_one_by_key_regex(&id_key_regex(meta_id))
                .await?
                .ok_or(FileException::MultipartNotFound { meta_id })?;
            if multipart.last_update_timestamp == multipart_now.last_update_timestamp {
                self.multipart_repo
                    .update_with_lease(
                        &id_hash_key(meta_id, &multipart.hash),
                        &multipart,
                        self.exp_msecs,
                    )
                    .await?;
                if !multipart.shards.is_empty() {
                    return Ok(multipart.shards.to_owned());
                }
                break multipart;
            }
            remaining_retries -= 1;
            if remaining_retries == 0 {
                let mut info = self
                    .move_registration_repo
                    .get_one_by_key_regex(&move_meta_id_key_regex(multipart.meta_id))
                    .await?
                    .with_context(|| format!("no move_reg for meta_id: {}", multipart.meta_id))?;
                info.is_upload_failed = true;
                let failed_reason = "Lock retry failed".to_string();
                info.failed_reason = Some(failed_reason.to_owned());
                self.move_registration_repo
                    .update_with_lease(
                        &move_meta_id_key_regex(multipart.meta_id),
                        &info,
                        self.exp_msecs,
                    )
                    .await?;
                // If is toggled by upload file task, report task failed.
                if let Some(task_id) = self.task_id {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: task_id,
                                info: Info::Task(TaskChangeInfo {
                                    status: TaskStatusChange::Failed,
                                    message: Some(failed_reason),
                                    ..Default::default()
                                }),
                            },
                            &self.status_mq_topic,
                        )
                        .await?;
                }

                return Err(FileException::InternalError {
                    source: anyhow::anyhow!("Failed lock retry!"),
                });
            }
            sleep(Duration::from_millis(200));
        };
        // retry logic end.

        let parts_len = multipart.part_count;
        let hash_algorithm = multipart.hash_algorithm.to_owned();
        let hash = multipart.hash.to_owned().to_uppercase();
        // If all parts are uploaded, merge them and delete multipart dir.
        let mut completed_content = vec![];
        for nth in 0..parts_len {
            let nth_content =
                self.cache_service.read(CacheReadCommand::ReadPart { meta_id, nth }).await?;
            completed_content.extend(nth_content);
        }
        let completed_content_hash = match hash_algorithm {
            HashAlgorithm::Blake3 => {
                blake3::hash(completed_content.as_slice()).to_string().to_uppercase()
            }
        };
        if completed_content_hash.ne(&hash) {
            let mut info = self
                .move_registration_repo
                .get_one_by_key_regex(&move_meta_id_key_regex(multipart.meta_id))
                .await?
                .with_context(|| format!("no move_reg for meta_id: {}", multipart.meta_id))?;
            info.is_upload_failed = true;
            let failed_reason = format!(
                "hash not match, provided: {}, completed: {}",
                hash, completed_content_hash
            );
            info.failed_reason = Some(failed_reason.to_owned());
            self.move_registration_repo
                .update_with_lease(
                    &move_meta_id_key_regex(multipart.meta_id),
                    &info,
                    self.exp_msecs,
                )
                .await?;
            // If is toggled by upload file task, report task failed.
            if let Some(task_id) = self.task_id {
                self.status_mq_producer
                    .send_object(
                        &ChangeMsg {
                            id: task_id,
                            info: Info::Task(TaskChangeInfo {
                                status: TaskStatusChange::Failed,
                                message: Some(failed_reason),
                                ..Default::default()
                            }),
                        },
                        &self.status_mq_topic,
                    )
                    .await?;
            }
            return Err(FileException::UnmatchedHash {
                meta_id,
                provided_hash: hash,
                completed_hash: completed_content_hash,
            });
        }

        self.cache_service
            .operate(CacheOperateCommand::WriteNormal {
                meta_id,
                content: completed_content,
            })
            .await?;
        self.cache_service
            .operate(CacheOperateCommand::RemoveMultipartDir { meta_id })
            .await?;
        Ok(vec![])
    }

    async fn info(&self, meta_id: Uuid) -> FileResult<Multipart> {
        Ok(self
            .multipart_repo
            .get_one_by_key_regex(&id_key_regex(meta_id))
            .await?
            .ok_or(FileException::MultipartNotFound { meta_id })?)
    }

    async fn remove(&self, meta_id: Uuid) -> FileResult<()> {
        self.multipart_repo.delete_by_key_regex(&id_key_regex(meta_id)).await?;
        let _ = self
            .cache_service
            .operate(CacheOperateCommand::RemoveMultipartDir { meta_id })
            .await;
        Ok(())
    }
}
