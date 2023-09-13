use anyhow::{anyhow, bail, Context};
use std::sync::Arc;
use uuid::Uuid;

use redis::{from_redis_value, Cmd, ConnectionLike, FromRedisValue, RedisResult, Value};
use typed_builder::TypedBuilder;

#[derive(TypedBuilder)]
pub struct RedisRepository {
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
    Single(redis::Connection),
    Cluster(redis::cluster::ClusterConnection),
}

impl RedisClient {
    pub fn get_connection(&self) -> RedisResult<RedisConnection> {
        match self {
            RedisClient::Single(s) => Ok(RedisConnection::Single(s.get_connection()?)),
            RedisClient::Cluster(c) => Ok(RedisConnection::Cluster(c.get_connection()?)),
        }
    }
}

impl RedisConnection {
    pub fn check_open(&self) -> anyhow::Result<()> {
        let flag = match self {
            RedisConnection::Single(sc) => sc.is_open(),
            RedisConnection::Cluster(cc) => cc.is_open(),
        };
        if !flag {
            anyhow::bail!("Redis connection is closed.");
        }
        Ok(())
    }

    pub fn query<T: FromRedisValue>(&mut self, cmd: &redis::Cmd) -> RedisResult<T> {
        match self {
            RedisConnection::Single(sc) => from_redis_value(&sc.req_command(cmd)?),
            RedisConnection::Cluster(cc) => from_redis_value(&cc.req_command(cmd)?),
        }
    }

    pub fn query_keys(&mut self, regex: &str) -> anyhow::Result<Vec<String>> {
        let cmd = &Cmd::keys(regex);
        Ok(match self {
            RedisConnection::Single(..) => self.query::<Vec<String>>(cmd)?,
            RedisConnection::Cluster(..) => {
                let r = self.query::<Value>(cmd)?;
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

impl RedisRepository {
    pub fn user_id(&self) -> anyhow::Result<Uuid> {
        self.user_id.context("No user id when redis repository need it.")
    }
}
