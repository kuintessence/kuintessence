use crate::prelude::*;
use alice_architecture::GenericError;
use CacheOperateCommand::*;
use CacheReadCommand::*;
use MultipartException::*;

#[derive(Builder)]
pub struct MultipartService {
    multipart_repo: Arc<dyn IMultipartRepo + Send + Sync>,
    cache_service: Arc<dyn ICacheService + Send + Sync>,
    #[builder(default = "24*60*60*1000")]
    exp_msecs: i64,
}
type Exception = GenericError<MultipartException>;

fn id_hash_key(id: Uuid, hash: &str) -> String {
    let hash = hash;
    format!("multipart_{id}_{hash}")
}

fn id_key_regex(id: Uuid) -> String {
    format!("multipart_{id}_*")
}

fn hash_key_regex(hash: &str) -> String {
    let hash = hash;
    format!("multipart_*_{hash}")
}

#[async_trait]
impl IMultipartService for MultipartService {
    async fn create(
        &self,
        meta_id: Uuid,
        hash: &str,
        hash_algorithm: HashAlgorithm,
        count: usize,
    ) -> Anyhow {
        // Test is hash the same.
        let same_hash = self.multipart_repo.get_one_by_key_regex(&hash_key_regex(hash)).await?;
        if let Some(el) = same_hash {
            bail!(Exception::Specific(ConflictedHash(
                el.meta_id,
                hash.to_owned()
            )))
        };

        // If hash isn't same, but id conflict, it is an error.
        let same_id = self.multipart_repo.get_one_by_key_regex(&id_key_regex(meta_id)).await?;
        if same_id.is_some() {
            bail!(Exception::Specific(ConflictedId(meta_id)))
        };

        let multipart = Multipart {
            meta_id,
            hash: hash.to_owned(),
            hash_algorithm,
            parts: vec![false; count],
        };
        self.multipart_repo
            .insert_with_lease(&id_hash_key(meta_id, hash), multipart, self.exp_msecs)
            .await?;
        Ok(())
    }

    async fn complete_part(&self, part: Part) -> AnyhowResult<Vec<usize>> {
        let meta_id = part.meta_id;
        let nth = part.nth;
        let content = part.content;
        // Cache part
        self.cache_service
            .operate(WritePart(Part {
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
            .ok_or(Exception::Specific(MultipartNotFound(meta_id)))?;
        let is_nth_uploaded = multipart
            .parts
            .get_mut(nth)
            .ok_or(Exception::Specific(NoSuchPart(meta_id, nth)))?;
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
        let hash = multipart.hash.to_owned();
        self.multipart_repo
            .update_with_lease(&id_hash_key(meta_id, &hash), multipart, self.exp_msecs)
            .await?;

        if !unfinished_parts.is_empty() {
            return Ok(unfinished_parts);
        }

        // If all parts are uploaded, merge them and delete multipart dir.
        let mut completed_content = vec![];
        for nth in 0..parts_len {
            let nth_content = self.cache_service.read(ReadPart { meta_id, nth }).await?;
            completed_content.extend(nth_content);
        }
        let completed_content_hash = match hash_algorithm {
            HashAlgorithm::Blake3 => {
                blake3::hash(completed_content.as_slice()).to_string().to_uppercase()
            }
        };
        if completed_content_hash.ne(&hash) {
            bail!(Exception::Specific(DifferentHashs(
                meta_id,
                hash,
                completed_content_hash
            )))
        }

        self.cache_service
            .operate(WriteNormal {
                meta_id,
                content: completed_content,
            })
            .await?;
        self.cache_service.operate(RemoveMultipartDir { meta_id }).await?;
        Ok(vec![])
    }

    async fn info(&self, meta_id: Uuid) -> AnyhowResult<Multipart> {
        self.multipart_repo
            .get_one_by_key_regex(&id_key_regex(meta_id))
            .await?
            .ok_or(anyhow!("No such multipart: {meta_id}"))
    }

    async fn remove(&self, meta_id: Uuid) -> Anyhow {
        self.multipart_repo.delete_by_key_regex(&id_key_regex(meta_id)).await?;
        let _ = self.cache_service.operate(RemoveMultipartDir { meta_id }).await;
        Ok(())
    }
}
