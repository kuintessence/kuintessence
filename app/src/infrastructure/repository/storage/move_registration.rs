use alice_architecture::repository::{
    DBRepository, LeaseDBRepository, LeaseRepository, MutableRepository, ReadOnlyRepository,
};
use anyhow::anyhow;
use async_trait::async_trait;
use domain_storage::{model::entity::MoveRegistration, repository::MoveRegistrationRepo};
use redis::Cmd;
use uuid::Uuid;

use crate::infrastructure::database::RedisRepository;

#[async_trait]
impl MoveRegistrationRepo for RedisRepository {
    async fn get_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<Vec<MoveRegistration>> {
        let mut connection = self.client.get_connection()?;

        connection.check_open()?;
        let keys = connection.query_keys(&format!("*_{key_regex}"))?;

        let values = if keys.len() == 1 {
            vec![connection.query::<String>(&Cmd::get(keys.get(0).unwrap()))?]
        } else if !keys.is_empty() {
            connection.query::<Vec<String>>(&Cmd::get(keys))?
        } else {
            vec![]
        };
        let x = values
            .iter()
            .map(|el| serde_json::from_str::<MoveRegistration>(el))
            .collect::<Result<_, _>>()?;
        Ok(x)
    }

    async fn get_one_by_key_regex(
        &self,
        key_regex: &str,
    ) -> anyhow::Result<Option<MoveRegistration>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(&format!("*_{key_regex}"))?;
        let key = keys.first();
        Ok(match key {
            Some(el) => {
                let x = connection.query::<String>(&Cmd::get(el))?;
                let result = serde_json::from_str::<MoveRegistration>(&x)?;
                Some(result)
            }
            None => None,
        })
    }

    async fn remove_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<()> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(&format!("*_{key_regex}"))?;
        connection.query(&Cmd::del(keys))?;
        Ok(())
    }
}

impl LeaseDBRepository<MoveRegistration> for RedisRepository {}

impl DBRepository<MoveRegistration> for RedisRepository {}

#[allow(warnings)]
#[async_trait]
impl LeaseRepository<MoveRegistration> for RedisRepository {
    async fn update_with_lease(
        &self,
        key: &str,
        entity: &MoveRegistration,
        ttl: i64,
    ) -> anyhow::Result<()> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let key_regex = format!("*_{key}");
        let keys = connection.query_keys(&key_regex)?;
        let key = keys.first().ok_or(anyhow!("No such move info: {key}"))?;
        let r = connection.query::<i64>(&Cmd::ttl(&key))?;
        if r == -2 {
            anyhow::bail!("The move_info has been deleted or expired.")
        }
        connection.query(&Cmd::pset_ex(
            key,
            serde_json::to_string(&entity).unwrap(),
            ttl as usize,
        ))?;
        Ok(())
    }

    async fn insert_with_lease(
        &self,
        key: &str,
        entity: &MoveRegistration,
        ttl: i64,
    ) -> anyhow::Result<Uuid> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let user_id = self.user_id()?;
        connection.query(&Cmd::pset_ex(
            format!("{user_id}_{key}"),
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        ))?;
        Ok(entity.id)
    }
}

#[allow(warnings)]
#[async_trait]
impl MutableRepository<MoveRegistration> for RedisRepository {}

#[allow(warnings)]
#[async_trait]
impl ReadOnlyRepository<MoveRegistration> for RedisRepository {}
