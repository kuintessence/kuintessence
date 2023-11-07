use alice_architecture::repository::{
    DBRepository, LeaseDBRepository, LeaseRepository, MutableRepository, ReadOnlyRepository,
};
use anyhow::anyhow;
use domain_storage::model::entity::Snapshot;
use domain_storage::repository::SnapshotRepo;
use redis::Cmd;
use uuid::Uuid;

use crate::infrastructure::database::RedisRepo;

#[inline]
fn any_user_key_regex(regex: &str) -> String {
    format!("*_{regex}")
}

#[async_trait::async_trait]
impl SnapshotRepo for RedisRepo {
    async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Snapshot>> {
        let regex = &any_user_key_regex(regex);
        let keys = self.query_keys(regex).await?;
        let key = keys.first();
        Ok(match key {
            Some(el) => {
                let x = self.query::<String>(&Cmd::get(el)).await?;
                let result = serde_json::from_str::<Snapshot>(&x)?;
                Some(result)
            }
            None => None,
        })
    }

    async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<Snapshot> {
        let regex = &any_user_key_regex(regex);
        let keys = self.query_keys(regex).await?;
        let key = keys.first().ok_or(anyhow!("No such snapshot with key regex: {regex}"))?;
        let r: String = self.query(&Cmd::get(key)).await?;
        self.query(&Cmd::del(key)).await?;
        Ok(serde_json::from_str(&r)?)
    }

    async fn get_all_by_key_regex(&self, regex: &str) -> anyhow::Result<Vec<Snapshot>> {
        let regex = &any_user_key_regex(regex);
        let keys = self.query_keys(regex).await?;
        let mut values = vec![];
        if keys.len() == 1 {
            values = vec![self.query::<String>(&Cmd::get(keys.first().unwrap())).await?]
        } else if !keys.is_empty() {
            values = self.query::<Vec<String>>(&Cmd::get(keys)).await?
        }
        Ok(values
            .iter()
            .map(|el| serde_json::from_str::<Snapshot>(el))
            .collect::<Result<Vec<Snapshot>, _>>()?)
    }
}

#[async_trait::async_trait]
impl LeaseDBRepository<Snapshot> for RedisRepo {}

#[async_trait::async_trait]
impl DBRepository<Snapshot> for RedisRepo {}

#[async_trait::async_trait]
impl LeaseRepository<Snapshot> for RedisRepo {
    async fn insert_with_lease(
        &self,
        key: &str,
        entity: &Snapshot,
        ttl: i64,
    ) -> anyhow::Result<Uuid> {
        let user_id = self.user_id()?;
        self.query(&Cmd::pset_ex(
            format!("{user_id}_{key}"),
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        )).await?;
        Ok(entity.id)
    }
}

#[async_trait::async_trait]
impl ReadOnlyRepository<Snapshot> for RedisRepo {}

#[async_trait::async_trait]
impl MutableRepository<Snapshot> for RedisRepo {}
