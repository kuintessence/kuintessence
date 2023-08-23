use super::RedisRepository;
use alice_architecture::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use kernel::prelude::*;
use redis::Cmd;
use std::str::FromStr;
use uuid::Uuid;

const TEXT_KEY_PREFIX: &str = "text_";

#[async_trait]
impl ITextStorageRepository for RedisRepository {
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = ids.iter().map(|el| format!("{TEXT_KEY_PREFIX}{el}")).collect::<Vec<_>>();
        let mut values = vec![];
        if keys.len() == 1 {
            values =
                vec![connection
                    .query::<String>(&Cmd::get::<String>(keys.get(0).unwrap().to_owned()))?];
        } else if !keys.is_empty() {
            values = connection.query::<Vec<String>>(&Cmd::get::<Vec<String>>(keys))?;
        }
        Ok(ids.iter().copied().zip(values).collect::<Vec<_>>())
    }
    async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let keys = connection.query_keys(&format!("{TEXT_KEY_PREFIX}*"))?;
        let mut values = vec![];
        if keys.len() == 1 {
            values =
                vec![connection
                    .query::<String>(&Cmd::get::<String>(keys.get(0).unwrap().to_owned()))?];
        } else if !keys.is_empty() {
            values = connection.query::<Vec<String>>(&Cmd::get::<Vec<String>>(keys.to_owned()))?;
        }
        let already_kv = keys.iter().zip(values).find(|(_, value)| value.eq(&text));
        Ok(match already_kv {
            Some((k, _)) => Some(Uuid::from_str(k.split(TEXT_KEY_PREFIX).nth(1).unwrap())?),
            None => None,
        })
    }
}

#[async_trait::async_trait]
impl IReadOnlyRepository<TextStorage> for RedisRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<TextStorage> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let result: Option<String> =
            connection.query(&Cmd::get(format!("{TEXT_KEY_PREFIX}{uuid}")))?;
        Ok(TextStorage {
            key: Some(Uuid::from_str(uuid)?),
            value: result.ok_or(anyhow::anyhow!("No such text key!"))?,
        })
    }

    async fn get_all(&self) -> anyhow::Result<Vec<TextStorage>> {
        unimplemented!()
    }
}

#[async_trait::async_trait]
impl IMutableRepository<TextStorage> for RedisRepository {
    async fn update(&self, entity: TextStorage) -> anyhow::Result<TextStorage> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let result = entity.clone();

        connection.query(&Cmd::getset(
            format!(
                "{TEXT_KEY_PREFIX}{}",
                entity.key.ok_or(anyhow::anyhow!("No such text key!"))?
            ),
            entity.value,
        ))?;
        Ok(result)
    }

    async fn insert(&self, entity: TextStorage) -> anyhow::Result<TextStorage> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let mut result = entity.clone();

        let already_key = self.text_already_uuid(&entity.value).await?;
        result.key = entity.key.or(already_key).or(Some(Uuid::new_v4()));
        connection.query(&Cmd::set(
            format!("{TEXT_KEY_PREFIX}{}", result.key.unwrap()),
            entity.value,
        ))?;
        Ok(TextStorage {
            key: result.key,
            value: String::default(),
        })
    }

    async fn delete(&self, entity: TextStorage) -> anyhow::Result<bool> {
        self.delete_by_id(
            entity.key.ok_or(anyhow::anyhow!("No such text key!"))?.to_string().as_str(),
            Option::<TextStorage>::None,
        )
        .await?;
        Ok(true)
    }

    async fn delete_by_id(&self, uuid: &str, _entity: Option<TextStorage>) -> anyhow::Result<bool> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        connection.query(&Cmd::del(format!("{TEXT_KEY_PREFIX}{uuid}")))?;
        Ok(true)
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        Ok(true)
    }
}

impl IDBRepository<TextStorage> for RedisRepository {}
