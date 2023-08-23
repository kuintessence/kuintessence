use super::RedisRepository;
use alice_architecture::{
    IDBRepository, ILeaseDBRepository, ILeaseRepository, IMutableRepository, IReadOnlyRepository,
};
use kernel::prelude::*;
use redis::Cmd;

type T = WsReqInfo;

impl ILeaseDBRepository<T> for RedisRepository {}

impl IDBRepository<T> for RedisRepository {}

#[async_trait]
impl IWsReqInfoRepo for RedisRepository {
    async fn delete_all_by_key_regex(&self, regex: &str) -> Anyhow {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(regex)?;
        connection.query(&Cmd::del(keys))?;
        Ok(())
    }
    async fn get_one_by_key_regex(&self, regex: &str) -> AnyhowResult<Option<WsReqInfo>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(regex)?;
        let key = keys.first();
        Ok(match key {
            Some(el) => {
                let x = connection.query::<String>(&Cmd::get(el))?;
                let result = serde_json::from_str::<T>(&x)?;
                Some(result)
            }
            None => None,
        })
    }
}

#[allow(warnings)]
#[async_trait]
impl ILeaseRepository<T> for RedisRepository {
    async fn update_with_lease(&self, key: &str, entity: T, ttl: i64) -> anyhow::Result<T> {
        unimplemented!()
    }

    async fn insert_with_lease(&self, key: &str, entity: T, ttl: i64) -> anyhow::Result<T> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        connection.query(&Cmd::pset_ex(
            key,
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        ))?;
        Ok(entity)
    }

    async fn keep_alive(&self, key: &str) -> anyhow::Result<bool> {
        unimplemented!()
    }
}

#[allow(warnings)]
#[async_trait]
impl IMutableRepository<T> for RedisRepository {
    async fn update(&self, entity: T) -> anyhow::Result<T> {
        unimplemented!()
    }
    async fn insert(&self, entity: T) -> anyhow::Result<T> {
        unimplemented!()
    }
    async fn delete(&self, entity: T) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn delete_by_id(&self, uuid: &str, entity: Option<T>) -> anyhow::Result<bool> {
        unimplemented!()
    }
    async fn save_changed(&self) -> anyhow::Result<bool> {
        unimplemented!()
    }
}

#[allow(warnings)]
#[async_trait]
impl IReadOnlyRepository<T> for RedisRepository {
    /// 根据 uuid 获取唯一对象
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<T> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let record: String = connection.query(&Cmd::get(uuid))?;
        Ok(serde_json::from_str(&record)?)
    }
    /// 获取所有对象
    async fn get_all(&self) -> anyhow::Result<Vec<T>> {
        unimplemented!()
    }
}
