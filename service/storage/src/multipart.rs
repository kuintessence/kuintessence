use std::sync::Arc;

use async_trait::async_trait;
use domain_storage::{
    command::{CacheOperateCommand, CacheReadCommand},
    exception::{FileException, FileResult},
    model::{
        entity::Multipart,
        vo::{HashAlgorithm, Part},
    },
    repository::MultipartRepo,
    service::{CacheService, MultipartService},
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct MultipartServiceImpl {
    multipart_repo: Arc<dyn MultipartRepo>,
    cache_service: Arc<dyn CacheService>,
    #[builder(default = 24 * 60 * 60 * 1000)]
    exp_msecs: i64,
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
            parts: vec![false; count as usize],
        };
        self.multipart_repo
            .insert_with_lease(&id_hash_key(meta_id, &hash), &multipart, self.exp_msecs)
            .await?;
        Ok(())
    }

    async fn complete_part(&self, part: Part) -> FileResult<Vec<usize>> {
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

        // Get multipart and update parts' is_uploaded bool value.
        let mut multipart = self
            .multipart_repo
            .get_one_by_key_regex(&id_key_regex(meta_id))
            .await?
            .ok_or(FileException::MultipartNotFound { meta_id })?;

        let is_nth_uploaded = multipart.parts.get_mut(nth).ok_or(FileException::NoSuchPart {
            meta_id,
            part_nth: nth,
        })?;
        *is_nth_uploaded = true;
        let unfinished_parts = multipart
            .parts
            .iter()
            .enumerate()
            .filter(|(_, el)| !*el)
            .map(|(n, _)| n)
            .collect::<Vec<_>>();
        let parts_len = multipart.parts.len();
        let hash_algorithm = multipart.hash_algorithm.to_owned();
        let hash = multipart.hash.to_owned().to_uppercase();
        self.multipart_repo
            .update_with_lease(&id_hash_key(meta_id, &hash), &multipart, self.exp_msecs)
            .await?;

        if !unfinished_parts.is_empty() {
            return Ok(unfinished_parts);
        }

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
