use anyhow::{anyhow, bail, Context};
use std::sync::Arc;
use uuid::Uuid;

use redis::{aio::ConnectionLike, from_redis_value, Cmd, FromRedisValue, RedisResult, Value};
use typed_builder::TypedBuilder;

#[derive(TypedBuilder)]
pub struct RedisRepo {
    pub client: Arc<RedisClient>,
    #[builder(default)]
    pub user_id: Option<Uuid>,
}

#[derive(Clone)]
pub enum RedisClient {
    Single(redis::Client),
    Cluster(redis::cluster::ClusterClient),
}

pub enum RedisConnection {
    Single(redis::aio::ConnectionManager),
    Cluster(redis::cluster_async::ClusterConnection),
}
impl RedisRepo {
    pub async fn query<T: FromRedisValue>(&self, cmd: &redis::Cmd) -> RedisResult<T> {
        self.client.get_connection().await?.query(cmd).await
    }
    pub async fn query_keys(&self, regex: &str) -> anyhow::Result<Vec<String>> {
        self.client.get_connection().await?.query_keys(regex).await
    }
}

impl RedisClient {
    async fn get_connection(&self) -> RedisResult<RedisConnection> {
        match self {
            RedisClient::Single(s) => Ok(RedisConnection::Single(
                s.get_tokio_connection_manager().await?,
            )),
            RedisClient::Cluster(c) => {
                Ok(RedisConnection::Cluster(c.get_async_connection().await?))
            }
        }
    }
}

impl RedisConnection {
    async fn query<T: FromRedisValue>(&mut self, cmd: &redis::Cmd) -> RedisResult<T> {
        match self {
            RedisConnection::Single(sc) => from_redis_value(&sc.req_packed_command(cmd).await?),
            RedisConnection::Cluster(cc) => from_redis_value(&cc.req_packed_command(cmd).await?),
        }
    }

    async fn query_keys(&mut self, regex: &str) -> anyhow::Result<Vec<String>> {
        let cmd = &Cmd::keys(regex);
        Ok(match self {
            RedisConnection::Single(..) => self.query::<Vec<String>>(cmd).await?,
            RedisConnection::Cluster(..) => {
                let r = self.query::<Value>(cmd).await?;
                let mut all_keys = vec![];
                match r {
                    Value::Bulk(items) => {
                        for item in items {
                            match item {
                                Value::Bulk(addr_and_value) => {
                                    let value = addr_and_value
                                        .last()
                                        .ok_or(anyhow!("No value for addr"))?;
                                    let keys: Vec<String> = from_redis_value(value)?;
                                    all_keys.extend_from_slice(&keys);
                                }
                                _ => bail!("Wrong type: not bulk"),
                            }
                        }
                    }
                    _ => bail!("Wrong type: not bulk"),
                }
                all_keys
            }
        })
    }
}

impl RedisRepo {
    pub fn user_id(&self) -> anyhow::Result<Uuid> {
        self.user_id.context("No user id when redis repository need it.")
    }
}
