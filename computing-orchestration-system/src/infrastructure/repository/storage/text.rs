use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};
use anyhow::Context;
use async_trait::async_trait;
use domain_storage::model::entity::{DbTextStorage, TextStorage};
use domain_storage::repository::TextStorageRepo;
use redis::Cmd;
use uuid::Uuid;

use crate::infrastructure::database::RedisRepo;

const TEXT_KEY_PREFIX: &str = "text_";

#[async_trait]
impl TextStorageRepo for RedisRepo {
    async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>> {
        let keys = ids.iter().map(|el| format!("{TEXT_KEY_PREFIX}{el}")).collect::<Vec<_>>();
        let mut values = vec![];
        if keys.len() == 1 {
            values = vec![
                self.query::<String>(&Cmd::get::<String>(keys.first().unwrap().to_owned()))
                    .await?,
            ];
        } else if !keys.is_empty() {
            values = self.query::<Vec<String>>(&Cmd::get::<Vec<String>>(keys)).await?;
        }
        Ok(ids.iter().copied().zip(values).collect::<Vec<_>>())
    }

    async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>> {
        let keys = self.query_keys(&format!("{TEXT_KEY_PREFIX}*")).await?;
        let mut values = vec![];
        if keys.len() == 1 {
            values = vec![
                self.query::<String>(&Cmd::get::<String>(keys.first().unwrap().to_owned()))
                    .await?,
            ];
        } else if !keys.is_empty() {
            values = self.query::<Vec<String>>(&Cmd::get::<Vec<String>>(keys.to_owned())).await?;
        }
        let already_kv = keys.iter().zip(values).find(|(_, value)| value.eq(&text));
        Ok(match already_kv {
            Some((k, _)) => Some(k.split(TEXT_KEY_PREFIX).nth(1).unwrap().parse()?),
            None => None,
        })
    }
}

#[async_trait::async_trait]
impl ReadOnlyRepository<TextStorage> for RedisRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<TextStorage> {
        let result: Option<String> =
            self.query(&Cmd::get(format!("{TEXT_KEY_PREFIX}{uuid}"))).await?;
        Ok(TextStorage {
            key: Some(uuid),
            value: result.context("No such text key!")?,
        })
    }
}

#[async_trait::async_trait]
impl MutableRepository<TextStorage> for RedisRepo {
    async fn update(&self, entity: DbTextStorage) -> anyhow::Result<()> {
        self.query(&Cmd::getset(
            format!(
                "{TEXT_KEY_PREFIX}{}",
                entity.key.value()?.ok_or(anyhow::anyhow!("No provided key!"))?
            ),
            entity.value.value()?.to_owned(),
        ))
        .await?;
        Ok(())
    }

    async fn insert(&self, entity: &TextStorage) -> anyhow::Result<Uuid> {
        let mut result = entity.clone();

        let already_key = self.text_already_uuid(&entity.value).await?;
        result.key = entity.key.or(already_key).or(Some(Uuid::new_v4()));
        self.query(&Cmd::set(
            format!("{TEXT_KEY_PREFIX}{}", result.key.unwrap()),
            entity.value.to_owned(),
        ))
        .await?;
        Ok(result.key.unwrap())
    }

    async fn delete(&self, entity: &TextStorage) -> anyhow::Result<()> {
        (self as &dyn MutableRepository<TextStorage>)
            .delete_by_id(entity.key.context("No such text key!")?)
            .await?;
        Ok(())
    }

    async fn delete_by_id(&self, uuid: Uuid) -> anyhow::Result<()> {
        self.query(&Cmd::del(format!("{TEXT_KEY_PREFIX}{uuid}"))).await?;
        Ok(())
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        Ok(true)
    }
}

impl DBRepository<TextStorage> for RedisRepo {}
