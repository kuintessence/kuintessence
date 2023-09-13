use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use anyhow::Context;
use async_trait::async_trait;
use domain_storage::model::entity::TextStorage;
use domain_storage::repository::TextStorageRepo;
use redis::Cmd;
use uuid::Uuid;

use crate::infrastructure::database::RedisRepository;

const TEXT_KEY_PREFIX: &str = "text_";

#[async_trait]
impl TextStorageRepo for RedisRepository {
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
            Some((k, _)) => Some(k.split(TEXT_KEY_PREFIX).nth(1).unwrap().parse()?),
            None => None,
        })
    }
}

#[async_trait::async_trait]
impl ReadOnlyRepository<TextStorage> for RedisRepository {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<TextStorage> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let result: Option<String> =
            connection.query(&Cmd::get(format!("{TEXT_KEY_PREFIX}{uuid}")))?;
        Ok(TextStorage {
            key: Some(uuid),
            value: result.context("No such text key!")?,
        })
    }
}

#[async_trait::async_trait]
impl MutableRepository<TextStorage> for RedisRepository {
    async fn update(&self, entity: &TextStorage) -> anyhow::Result<()> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;

        connection.query(&Cmd::getset(
            format!(
                "{TEXT_KEY_PREFIX}{}",
                entity.key.ok_or(anyhow::anyhow!("No such text key!"))?
            ),
            entity.value.to_owned(),
        ))?;
        Ok(())
    }

    async fn insert(&self, entity: &TextStorage) -> anyhow::Result<Uuid> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        let mut result = entity.clone();

        let already_key = self.text_already_uuid(&entity.value).await?;
        result.key = entity.key.or(already_key).or(Some(Uuid::new_v4()));
        connection.query(&Cmd::set(
            format!("{TEXT_KEY_PREFIX}{}", result.key.unwrap()),
            entity.value.to_owned(),
        ))?;
        Ok(result.key.unwrap())
    }

    async fn delete(&self, entity: &TextStorage) -> anyhow::Result<()> {
        (self as &dyn MutableRepository<TextStorage>)
            .delete_by_id(entity.key.context("No such text key!")?)
            .await?;
        Ok(())
    }

    async fn delete_by_id(&self, uuid: Uuid) -> anyhow::Result<()> {
        let mut connection = self.client.get_connection()?;
        connection.check_open()?;
        connection.query(&Cmd::del(format!("{TEXT_KEY_PREFIX}{uuid}")))?;
        Ok(())
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        Ok(true)
    }
}

impl DBRepository<TextStorage> for RedisRepository {}
