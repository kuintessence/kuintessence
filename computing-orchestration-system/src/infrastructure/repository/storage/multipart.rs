use alice_architecture::repository::{
    DBRepository, LeaseDBRepository, LeaseRepository, MutableRepository, ReadOnlyRepository,
};
use anyhow::anyhow;
use domain_storage::{
    exception::{FileException, FileResult},
    model::entity::Multipart,
    repository::MultipartRepo,
};
use redis::Cmd;
use uuid::Uuid;

use crate::infrastructure::database::RedisRepo;

#[async_trait::async_trait]
impl MultipartRepo for RedisRepo {
    async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Multipart>> {
        let keys = self.query_keys(regex).await?;
        let key = keys.first();
        Ok(match key {
            Some(el) => {
                let x = self.query::<String>(&Cmd::get(el)).await?;
                let result = serde_json::from_str::<Multipart>(&x)?;
                Some(result)
            }
            None => None,
        })
    }

    async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<()> {
        let keys = self.query_keys(regex).await?;
        let key = keys.first().ok_or(anyhow!("No such multipart with regex: {regex}"))?;
        self.query(&Cmd::del(key)).await?;
        Ok(())
    }

    async fn remove_nth(&self, id: Uuid, nth: u64, ttl: i64) -> FileResult<Multipart> {
        let lock_key = format!("m_lock_{}", id);
        let get_lock: bool =
            self.query(&Cmd::set_nx(&lock_key, 1)).await.map_err(|e| anyhow!(e))?;
        if get_lock {
            let mut multipart = self
                .get_one_by_key_regex(&format!("multipart_{id}_*"))
                .await?
                .ok_or(FileException::MultipartNotFound { meta_id: id })?;
            multipart.shards.retain(|c| !c.eq(&nth));
            (self as &dyn LeaseRepository<Multipart>)
                .update_with_lease(
                    &format!("multipart_{id}_{}", multipart.hash),
                    &multipart,
                    ttl,
                )
                .await?;
            self.query(&Cmd::del(lock_key)).await.map_err(|e| anyhow!(e))?;
            Ok(multipart)
        } else {
            Err(anyhow!("Can not get lock.").into())
        }
    }
}

#[async_trait::async_trait]
impl LeaseDBRepository<Multipart> for RedisRepo {}

#[async_trait::async_trait]
impl DBRepository<Multipart> for RedisRepo {}

#[async_trait::async_trait]
impl LeaseRepository<Multipart> for RedisRepo {
    async fn update_with_lease(
        &self,
        key: &str,
        entity: &Multipart,
        ttl: i64,
    ) -> anyhow::Result<()> {
        self.query(&Cmd::pset_ex(
            key,
            serde_json::to_string_pretty(&entity)?,
            ttl as u64,
        ))
        .await?;
        Ok(())
    }

    async fn insert_with_lease(
        &self,
        key: &str,
        entity: &Multipart,
        ttl: i64,
    ) -> anyhow::Result<Uuid> {
        self.query(&Cmd::pset_ex(
            key,
            serde_json::to_string_pretty(&entity)?,
            ttl as u64,
        ))
        .await?;
        Ok(entity.meta_id)
    }
}

#[async_trait::async_trait]
impl ReadOnlyRepository<Multipart> for RedisRepo {}

#[async_trait::async_trait]
impl MutableRepository<Multipart> for RedisRepo {}
