use alice_architecture::utils::*;
use alice_architecture::{
    IDBRepository, ILeaseDBRepository, ILeaseRepository, IMutableRepository, IReadOnlyRepository,
};
use domain_storage::model::entity::Snapshot;
use domain_storage::repository::SnapshotRepo;
use redis::Cmd;

use crate::infrastructure::database::RedisRepository;

#[inline]
fn any_user_key_regex(regex: &str) -> String {
    format!("*_{regex}")
}

#[async_trait::async_trait]
impl SnapshotRepo for RedisRepository {
    async fn get_one_by_key_regex(&self, regex: &str) -> Anyhow<Option<Snapshot>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let regex = &any_user_key_regex(regex);
        let keys = connection.query_keys(regex)?;
        let key = keys.first();
        Ok(match key {
            Some(el) => {
                let x = connection.query::<String>(&Cmd::get(el))?;
                let result = serde_json::from_str::<Snapshot>(&x)?;
                Some(result)
            }
            None => None,
        })
    }

    async fn delete_by_key_regex(&self, regex: &str) -> Anyhow<Snapshot> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let regex = &any_user_key_regex(regex);
        let keys = connection.query_keys(regex)?;
        let key = keys.first().ok_or(anyhow!("No such snapshot with key regex: {regex}"))?;
        let r: String = connection.query(&Cmd::get(key))?;
        connection.query(&Cmd::del(key))?;
        Ok(serde_json::from_str(&r)?)
    }

    async fn get_all_by_key_regex(&self, regex: &str) -> Anyhow<Vec<Snapshot>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let regex = &any_user_key_regex(regex);
        let keys = connection.query_keys(regex)?;
        let mut values = vec![];
        if keys.len() == 1 {
            values = vec![connection.query::<String>(&Cmd::get(keys.first().unwrap()))?]
        } else if !keys.is_empty() {
            values = connection.query::<Vec<String>>(&Cmd::get(keys))?
        }
        Ok(values
            .iter()
            .map(|el| serde_json::from_str::<Snapshot>(el))
            .collect::<Result<Vec<Snapshot>, _>>()?)
    }
}

#[async_trait::async_trait]
impl ILeaseDBRepository<Snapshot> for RedisRepository {}

#[async_trait::async_trait]
impl IDBRepository<Snapshot> for RedisRepository {}

#[async_trait::async_trait]
impl ILeaseRepository<Snapshot> for RedisRepository {
    async fn update_with_lease(
        &self,
        _key: &str,
        _entity: Snapshot,
        _ttl: i64,
    ) -> anyhow::Result<Snapshot> {
        unimplemented!()
    }

    async fn insert_with_lease(
        &self,
        key: &str,
        entity: Snapshot,
        ttl: i64,
    ) -> anyhow::Result<Snapshot> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let user_id = entity.user_id;
        connection.query(&Cmd::pset_ex(
            format!("{user_id}_{key}"),
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
impl IReadOnlyRepository<Snapshot> for RedisRepository {
    async fn get_by_id(&self, _uuid: &str) -> anyhow::Result<Snapshot> {
        unimplemented!()
    }

    async fn get_all(&self) -> anyhow::Result<Vec<Snapshot>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl IMutableRepository<Snapshot> for RedisRepository {
    async fn update(&self, _entity: Snapshot) -> anyhow::Result<Snapshot> {
        unimplemented!()
    }

    async fn insert(&self, _entity: Snapshot) -> anyhow::Result<Snapshot> {
        unimplemented!()
    }

    async fn delete(&self, _entity: Snapshot) -> anyhow::Result<bool> {
        unimplemented!()
    }

    async fn delete_by_id(&self, _uuid: &str, _entity: Option<Snapshot>) -> anyhow::Result<bool> {
        unimplemented!()
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        unimplemented!()
    }
}
