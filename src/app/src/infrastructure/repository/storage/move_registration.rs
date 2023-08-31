use alice_architecture::utils::*;
use alice_architecture::{
    IDBRepository, ILeaseDBRepository, ILeaseRepository, IMutableRepository, IReadOnlyRepository,
};
use domain_storage::{model::entity::MoveRegistration, repository::MoveRegistrationRepo};
use redis::Cmd;

use crate::infrastructure::database::RedisRepository;

#[async_trait]
impl MoveRegistrationRepo for RedisRepository {
    async fn get_all_by_key_regex(&self, key_regex: &str) -> Anyhow<Vec<MoveRegistration>> {
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

    async fn get_one_by_key_regex(&self, key_regex: &str) -> Anyhow<Option<MoveRegistration>> {
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

    async fn get_user_by_key_regex(&self, key_regex: &str) -> Anyhow<Option<Uuid>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(&format!("*_{key_regex}"))?;
        let key = keys.first();

        Ok(match key {
            Some(el) => {
                let user_id = Uuid::parse_str(el.split('_').next().unwrap())?;
                Some(user_id)
            }
            None => None,
        })
    }

    async fn remove_all_by_key_regex(&self, key_regex: &str) -> Anyhow {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(&format!("*_{key_regex}"))?;
        connection.query(&Cmd::del(keys))?;
        Ok(())
    }
}

impl ILeaseDBRepository<MoveRegistration> for RedisRepository {}

impl IDBRepository<MoveRegistration> for RedisRepository {}

#[allow(warnings)]
#[async_trait]
impl ILeaseRepository<MoveRegistration> for RedisRepository {
    async fn update_with_lease(
        &self,
        key: &str,
        entity: MoveRegistration,
        ttl: i64,
    ) -> anyhow::Result<MoveRegistration> {
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
        Ok(entity)
    }

    async fn insert_with_lease(
        &self,
        key: &str,
        entity: MoveRegistration,
        ttl: i64,
    ) -> anyhow::Result<MoveRegistration> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let user_id = entity
            .user_id
            .map(|el| el.to_string())
            .or(self.user_id.to_owned())
            .ok_or(anyhow!("No user info when redis need it."))?;
        connection.query(&Cmd::pset_ex(
            format!("{user_id}_{key}"),
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
impl IMutableRepository<MoveRegistration> for RedisRepository {
    async fn update(&self, entity: MoveRegistration) -> anyhow::Result<MoveRegistration> {
        unimplemented!()
    }

    async fn insert(&self, entity: MoveRegistration) -> anyhow::Result<MoveRegistration> {
        unimplemented!()
    }

    async fn delete(&self, entity: MoveRegistration) -> anyhow::Result<bool> {
        unimplemented!()
    }

    async fn delete_by_id(
        &self,
        uuid: &str,
        entity: Option<MoveRegistration>,
    ) -> anyhow::Result<bool> {
        unimplemented!()
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        unimplemented!()
    }
}

#[allow(warnings)]
#[async_trait]
impl IReadOnlyRepository<MoveRegistration> for RedisRepository {
    /// 根据 uuid 获取唯一对象
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<MoveRegistration> {
        unimplemented!()
    }

    /// 获取所有对象
    async fn get_all(&self) -> anyhow::Result<Vec<MoveRegistration>> {
        unimplemented!()
    }
}
