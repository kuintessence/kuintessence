use alice_architecture::repository::{
    DBRepository, LeaseDBRepository, LeaseRepository, MutableRepository, ReadOnlyRepository,
};
use anyhow::anyhow;
use domain_storage::{model::entity::Multipart, repository::MultipartRepo};
use redis::Cmd;
use uuid::Uuid;

use crate::infrastructure::database::RedisRepository;

#[async_trait::async_trait]
impl MultipartRepo for RedisRepository {
    async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Multipart>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(regex)?;
        let key = keys.first();
        Ok(match key {
            Some(el) => {
                let x = connection.query::<String>(&Cmd::get(el))?;
                let result = serde_json::from_str::<Multipart>(&x)?;
                Some(result)
            }
            None => None,
        })
    }

    async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<()> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(regex)?;
        let key = keys.first().ok_or(anyhow!("No such multipart with regex: {regex}"))?;
        connection.query(&Cmd::del(key))?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl LeaseDBRepository<Multipart> for RedisRepository {}

#[async_trait::async_trait]
impl DBRepository<Multipart> for RedisRepository {}

#[async_trait::async_trait]
impl LeaseRepository<Multipart> for RedisRepository {
    async fn update_with_lease(
        &self,
        key: &str,
        entity: &Multipart,
        ttl: i64,
    ) -> anyhow::Result<()> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        connection.query(&Cmd::pset_ex(
            key,
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        ))?;
        Ok(())
    }

    async fn insert_with_lease(
        &self,
        key: &str,
        entity: &Multipart,
        ttl: i64,
    ) -> anyhow::Result<Uuid> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        connection.query(&Cmd::pset_ex(
            key,
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        ))?;
        Ok(entity.meta_id)
    }
}

#[async_trait::async_trait]
impl ReadOnlyRepository<Multipart> for RedisRepository {}

#[async_trait::async_trait]
impl MutableRepository<Multipart> for RedisRepository {}
