use super::RedisRepository;
use alice_architecture::{
    IDBRepository, ILeaseDBRepository, ILeaseRepository, IMutableRepository, IReadOnlyRepository,
};
use kernel::prelude::*;
use redis::Cmd;

#[async_trait::async_trait]
impl IMultipartRepo for RedisRepository {
    async fn get_one_by_key_regex(&self, regex: &str) -> AnyhowResult<Option<Multipart>> {
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

    async fn delete_by_key_regex(&self, regex: &str) -> Anyhow {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(regex)?;
        let key = keys.first().ok_or(anyhow!("No such multipart with regex: {regex}"))?;
        connection.query(&Cmd::del(key))?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl ILeaseDBRepository<Multipart> for RedisRepository {}
#[async_trait::async_trait]
impl IDBRepository<Multipart> for RedisRepository {}

#[async_trait::async_trait]
impl ILeaseRepository<Multipart> for RedisRepository {
    async fn update_with_lease(
        &self,
        key: &str,
        entity: Multipart,
        ttl: i64,
    ) -> anyhow::Result<Multipart> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        connection.query(&Cmd::pset_ex(
            key,
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        ))?;
        Ok(entity)
    }
    async fn insert_with_lease(
        &self,
        key: &str,
        entity: Multipart,
        ttl: i64,
    ) -> anyhow::Result<Multipart> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        connection.query(&Cmd::pset_ex(
            key,
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        ))?;
        Ok(entity)
    }
    async fn keep_alive(&self, _key: &str) -> anyhow::Result<bool> {
        unimplemented!()
    }
}
#[async_trait::async_trait]
impl IReadOnlyRepository<Multipart> for RedisRepository {
    async fn get_by_id(&self, _uuid: &str) -> anyhow::Result<Multipart> {
        unimplemented!()
    }
    async fn get_all(&self) -> anyhow::Result<Vec<Multipart>> {
        unimplemented!()
    }
}
#[async_trait::async_trait]
impl IMutableRepository<Multipart> for RedisRepository {
    async fn update(&self, _entity: Multipart) -> anyhow::Result<Multipart> {
        unimplemented!()
    }
    async fn insert(&self, _entity: Multipart) -> anyhow::Result<Multipart> {
        unimplemented!()
    }
    async fn delete(&self, _entity: Multipart) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn delete_by_id(&self, _uuid: &str, _entity: Option<Multipart>) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn save_changed(&self) -> anyhow::Result<bool> {
        unimplemented!()
    }
}
