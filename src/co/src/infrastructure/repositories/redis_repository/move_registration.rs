use super::RedisRepository;
use alice_architecture::{
    IDBRepository, ILeaseDBRepository, ILeaseRepository, IMutableRepository, IReadOnlyRepository,
};
use kernel::prelude::*;
use redis::Cmd;

type T = MoveRegistration;

#[async_trait]
impl IMoveRegistrationRepo for RedisRepository {
    async fn get_all_by_key_regex(&self, key_regex: &str) -> AnyhowResult<Vec<T>> {
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
            .map(|el| serde_json::from_str::<T>(el))
            .collect::<Result<_, _>>()?;
        Ok(x)
    }
    async fn get_one_by_key_regex(
        &self,
        key_regex: &str,
    ) -> AnyhowResult<Option<MoveRegistration>> {
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

    async fn get_user_by_key_regex(&self, key_regex: &str) -> AnyhowResult<Option<Uuid>> {
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

impl ILeaseDBRepository<T> for RedisRepository {}

impl IDBRepository<T> for RedisRepository {}

#[allow(warnings)]
#[async_trait]
impl ILeaseRepository<T> for RedisRepository {
    async fn update_with_lease(&self, key: &str, entity: T, ttl: i64) -> anyhow::Result<T> {
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

    async fn insert_with_lease(&self, key: &str, entity: T, ttl: i64) -> anyhow::Result<T> {
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
        unimplemented!()
    }
    /// 获取所有对象
    async fn get_all(&self) -> anyhow::Result<Vec<T>> {
        unimplemented!()
    }
}
