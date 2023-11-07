use alice_architecture::repository::{
    DBRepository, LeaseDBRepository, LeaseRepository, MutableRepository, ReadOnlyRepository,
};
use anyhow::anyhow;
use async_trait::async_trait;
use domain_storage::{model::entity::MoveRegistration, repository::MoveRegistrationRepo};
use redis::Cmd;
use uuid::Uuid;

use crate::infrastructure::database::RedisRepo;

#[async_trait]
impl MoveRegistrationRepo for RedisRepo {
    async fn get_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<Vec<MoveRegistration>> {
        let keys = self.query_keys(&format!("*_{key_regex}")).await?;

        let values = if keys.len() == 1 {
            vec![self.query::<String>(&Cmd::get(keys.get(0).unwrap())).await?]
        } else if !keys.is_empty() {
            self.query::<Vec<String>>(&Cmd::get(keys)).await?
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
        let keys = self.query_keys(&format!("*_{key_regex}")).await?;
        let key = keys.first();
        Ok(match key {
            Some(el) => {
                let x = self.query::<String>(&Cmd::get(el)).await?;
                let result = serde_json::from_str::<MoveRegistration>(&x)?;
                Some(result)
            }
            None => None,
        })
    }

    async fn remove_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<()> {
        let keys = self.query_keys(&format!("*_{key_regex}")).await?;
        self.query(&Cmd::del(keys)).await?;
        Ok(())
    }
}

impl LeaseDBRepository<MoveRegistration> for RedisRepo {}

impl DBRepository<MoveRegistration> for RedisRepo {}

#[allow(warnings)]
#[async_trait]
impl LeaseRepository<MoveRegistration> for RedisRepo {
    async fn update_with_lease(
        &self,
        key: &str,
        entity: &MoveRegistration,
        ttl: i64,
    ) -> anyhow::Result<()> {
        let key_regex = format!("*_{key}");
        let keys = self.query_keys(&key_regex).await?;
        let key = keys.first().ok_or(anyhow!("No such move info: {key}"))?;
        let r = self.query::<i64>(&Cmd::ttl(&key)).await?;
        if r == -2 {
            anyhow::bail!("The move_info has been deleted or expired.")
        }
        self.query(&Cmd::pset_ex(
            key,
            serde_json::to_string(&entity).unwrap(),
            ttl as usize,
        ))
        .await?;
        Ok(())
    }

    async fn insert_with_lease(
        &self,
        key: &str,
        entity: &MoveRegistration,
        ttl: i64,
    ) -> anyhow::Result<Uuid> {
        let user_id = self.user_id()?;
        self.query(&Cmd::pset_ex(
            format!("{user_id}_{key}"),
            serde_json::to_string_pretty(&entity)?,
            ttl as usize,
        ))
        .await?;
        Ok(entity.id)
    }
}

#[allow(warnings)]
#[async_trait]
impl MutableRepository<MoveRegistration> for RedisRepo {}

#[allow(warnings)]
#[async_trait]
impl ReadOnlyRepository<MoveRegistration> for RedisRepo {}
