use kernel::prelude::*;
use redis::{from_redis_value, Cmd, ConnectionLike, FromRedisValue, RedisResult, Value};

mod move_registration;
mod multipart;
mod snapshot;
mod text;
mod ws_req_info;

#[derive(Clone)]
pub enum RedisClient {
    Single(redis::Client),
    Cluster(redis::cluster::ClusterClient),
}

impl RedisClient {
    pub fn get_connection(&self) -> RedisResult<RedisConnection> {
        match self {
            RedisClient::Single(s) => Ok(RedisConnection::Single(s.get_connection()?)),
            RedisClient::Cluster(c) => Ok(RedisConnection::Cluster(c.get_connection()?)),
        }
    }
}

pub enum RedisConnection {
    Single(redis::Connection),
    Cluster(redis::cluster::ClusterConnection),
}

impl RedisConnection {
    pub fn check_open(&self) -> Anyhow {
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

    pub fn query_keys(&mut self, regex: &str) -> AnyhowResult<Vec<String>> {
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

#[derive(Builder)]
pub struct RedisRepository {
    client: Arc<RedisClient>,
    #[builder(default = "None")]
    user_id: Option<String>,
}

// impl RedisRepository {
//     pub(self) fn user_key(&self, key: &str) -> anyhow::Result<String> {
//         let user_id = &self
//             .user_id
//             .as_ref()
//             .ok_or(anyhow::anyhow!("Redis repo no user info when using"))?;
//         Ok(format!("{user_id}_{key}"))
//     }
// }

// #[async_trait::async_trait]
// impl ILeaseDBRepository<SnapshotRecord> for RedisRepository {}
// #[async_trait::async_trait]
// impl IDBRepository<SnapshotRecord> for RedisRepository {}
// #[async_trait::async_trait]
// impl ILeaseRepository<SnapshotRecord> for RedisRepository {
//     async fn update_with_lease(
//         &self,
//         _key: &str,
//         _entity: SnapshotRecord,
//         _ttl: i64,
//     ) -> anyhow::Result<SnapshotRecord> {
//         unimplemented!()
//     }
//     async fn insert_with_lease(
//         &self,
//         _key: &str,
//         entity: SnapshotRecord,
//         ttl: i64,
//     ) -> anyhow::Result<SnapshotRecord> {
//         let mut con = self.client.get_async_connection().await?;
//         let key = SnapshotRecord::key(SnapshotKeyOptions {
//             hash: Some(&entity.hash),
//             uid: Some(self.user_id),
//             node_id: Some(entity.node_id),
//             fid: Some(entity.file_id),
//             timestamp: Some(entity.timestamp),
//         });
//         con.pset_ex(
//             key,
//             serde_json::to_string(&entity).unwrap(),
//             ttl.try_into().unwrap(),
//         )
//         .await?;
//         Ok(entity)
//     }
//     async fn keep_alive(&self, _key: &str) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
// }
// #[async_trait::async_trait]
// impl IReadOnlyRepository<SnapshotRecord> for RedisRepository {
//     async fn get_by_id(&self, _uuid: &str) -> anyhow::Result<SnapshotRecord> {
//         unimplemented!()
//     }
//     async fn get_all(&self) -> anyhow::Result<Vec<SnapshotRecord>> {
//         unimplemented!()
//     }
// }
// #[async_trait::async_trait]
// impl IMutableRepository<SnapshotRecord> for RedisRepository {
//     async fn update(&self, _entity: SnapshotRecord) -> anyhow::Result<SnapshotRecord> {
//         unimplemented!()
//     }
//     async fn insert(&self, _entity: SnapshotRecord) -> anyhow::Result<SnapshotRecord> {
//         unimplemented!()
//     }
//     async fn delete(&self, _entity: SnapshotRecord) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
//     async fn delete_by_id(
//         &self,
//         _uuid: &str,
//         _entity: Option<SnapshotRecord>,
//     ) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
//     async fn save_changed(&self) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
// }

// #[async_trait::async_trait]
// impl ISnapshotRepository2 for RedisRepository {
//     async fn get_snapshots(
//         &self,
//         node_id: Uuid,
//         file_id: Uuid,
//     ) -> anyhow::Result<Vec<SnapshotRecord>> {
//         let mut connection = self.client.get_async_connection().await?;
//         let key_regex = SnapshotRecord::key(SnapshotKeyOptions {
//             hash: None,
//             uid: Some(self.user_id),
//             node_id: Some(node_id),
//             fid: Some(file_id),
//             timestamp: None,
//         });
//         let records = connection.keys::<String, Vec<String>>(key_regex).await?;
//         let mut values = vec![];
//         if records.len() == 1 {
//             values = vec![
//                 connection
//                     .get::<String, String>(records.get(0).unwrap().to_owned())
//                     .await?,
//             ];
//         } else if !records.is_empty() {
//             values = connection.get::<Vec<String>, Vec<String>>(records).await?;
//         }
//         Ok(values
//             .iter()
//             .map(|el| serde_json::from_str::<SnapshotRecord>(&el).unwrap())
//             .collect::<Vec<_>>())
//     }
//     async fn remove(&self, info: &SnapshotIdent) -> anyhow::Result<()> {
//         let mut connection = self.client.get_async_connection().await?;
//         let key_regex = SnapshotRecord::key(SnapshotKeyOptions {
//             hash: None,
//             uid: Some(self.user_id),
//             node_id: Some(info.node_id),
//             fid: Some(info.file_id),
//             timestamp: Some(info.timestamp),
//         });
//         let record = connection.keys::<String, Vec<String>>(key_regex).await?;
//         let key = record.get(0);
//         Ok(match key {
//             Some(el) => {
//                 connection.del(el).await?;
//             }
//             None => {
//                 bail!("No such snapshot!")
//             }
//         })
//     }

//     async fn get_by_hash(&self, hash: &str) -> anyhow::Result<Option<SnapshotRecord>> {
//         let mut connection = self.client.get_async_connection().await?;
//         let key_regex = SnapshotRecord::key(SnapshotKeyOptions {
//             hash: Some(hash),
//             uid: None,
//             node_id: None,
//             fid: None,
//             timestamp: None,
//         });
//         let record = connection.keys::<String, Vec<String>>(key_regex).await?;
//         let key = record.get(0);
//         Ok(match key {
//             Some(el) => {
//                 let result = connection.get::<&String, String>(el).await?;
//                 let ans = serde_json::from_str::<SnapshotRecord>(&result)?;
//                 Some(ans)
//             }
//             None => None,
//         })
//     }
// }

// #[async_trait::async_trait]
// impl ILeaseDBRepository<SnapshotInfo> for RedisRepository {}
// #[async_trait::async_trait]
// impl IDBRepository<SnapshotInfo> for RedisRepository {}
// #[async_trait::async_trait]
// impl ILeaseRepository<SnapshotInfo> for RedisRepository {
//     async fn update_with_lease(
//         &self,
//         _key: &str,
//         _entity: SnapshotInfo,
//         _ttl: i64,
//     ) -> anyhow::Result<SnapshotInfo> {
//         unimplemented!()
//     }
//     async fn insert_with_lease(
//         &self,
//         key: &str,
//         entity: SnapshotInfo,
//         ttl: i64,
//     ) -> anyhow::Result<SnapshotInfo> {
//         let mut con = self.client.get_async_connection().await?;
//         con.pset_ex(
//             format!("{SNAPSHOT_PREFIX}{key}"),
//             serde_json::to_string(&entity).unwrap(),
//             ttl.try_into().unwrap(),
//         )
//         .await?;
//         Ok(entity)
//     }
//     async fn keep_alive(&self, _key: &str) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
// }
// #[async_trait::async_trait]
// impl IReadOnlyRepository<SnapshotInfo> for RedisRepository {
//     async fn get_by_id(&self, uuid: &str) -> anyhow::Result<SnapshotInfo> {
//         let mut connection = self.client.get_async_connection().await?;
//         let result = connection
//             .get::<String, Option<String>>(format!("{SNAPSHOT_PREFIX}{uuid}"))
//             .await?
//             .ok_or(anyhow!("No such snapshot key: {uuid}"))?;
//         let snapshot_info = serde_json::from_str::<SnapshotInfo>(&result)?;
//         Ok(snapshot_info)
//     }
//     async fn get_all(&self) -> anyhow::Result<Vec<SnapshotInfo>> {
//         unimplemented!()
//     }
// }
// #[async_trait::async_trait]
// impl IMutableRepository<SnapshotInfo> for RedisRepository {
//     async fn update(&self, _entity: SnapshotInfo) -> anyhow::Result<SnapshotInfo> {
//         unimplemented!()
//     }
//     async fn insert(&self, _entity: SnapshotInfo) -> anyhow::Result<SnapshotInfo> {
//         unimplemented!()
//     }
//     async fn delete(&self, _entity: SnapshotInfo) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
//     async fn delete_by_id(
//         &self,
//         uuid: &str,
//         _entity: Option<SnapshotInfo>,
//     ) -> anyhow::Result<bool> {
//         let mut connection = self.client.get_async_connection().await?;
//         connection.del(format!("{SNAPSHOT_PREFIX}{uuid}")).await?;
//         Ok(true)
//     }
//     async fn save_changed(&self) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
// }

// #[async_trait::async_trait]
// impl ISnapshotRepository for RedisRepository {
//     async fn get_by_node_file_timestamp(
//         &self,
//         node_id: Uuid,
//         file_id: Uuid,
//         timestamp: i64,
//     ) -> anyhow::Result<Option<SnapshotInfo>> {
//         let mut connection = self.client.get_async_connection().await?;
//         let records = connection
//             .keys::<String, Vec<String>>(format!("{SNAPSHOT_PREFIX}*"))
//             .await?;
//         let mut values = vec![];
//         if records.len() == 1 {
//             values = vec![
//                 connection
//                     .get::<String, String>(records.get(0).unwrap().to_owned())
//                     .await?,
//             ];
//         } else if !records.is_empty() {
//             values = connection.get::<Vec<String>, Vec<String>>(records).await?;
//         }
//         Ok(values
//             .iter()
//             .map(|el| serde_json::from_str::<SnapshotInfo>(&el).unwrap())
//             .filter(|el| el.file_id.eq(&file_id))
//             .filter(|el| el.timestamp.eq(&timestamp))
//             .find(|el| el.node_id.eq(&node_id)))
//     }
//     async fn delete_by_node_file_timestamp(
//         &self,
//         node_id: Uuid,
//         file_id: Uuid,
//         timestamp: i64,
//     ) -> anyhow::Result<()> {
//         let mut connection = self.client.get_async_connection().await?;
//         let records = connection
//             .keys::<String, Vec<String>>(format!("{SNAPSHOT_PREFIX}*"))
//             .await?;
//         let mut values = vec![];
//         if records.len() == 1 {
//             values = vec![
//                 connection
//                     .get::<String, String>(records.get(0).unwrap().to_owned())
//                     .await?,
//             ];
//         } else if !records.is_empty() {
//             values = connection.get::<Vec<String>, Vec<String>>(records).await?;
//         }
//         let del_snapshot = values
//             .iter()
//             .map(|el| serde_json::from_str::<SnapshotInfo>(&el).unwrap())
//             .filter(|el| el.file_id.eq(&file_id))
//             .filter(|el| el.timestamp.eq(&timestamp))
//             .find(|el| el.node_id.eq(&node_id));
//         let del_snapshot = match del_snapshot {
//             Some(el) => el,
//             None => bail!("snapshot is None!"),
//         };
//         connection
//             .del(&del_snapshot.id.to_string().as_str())
//             .await?;
//         Ok(())
//     }
// }

// #[async_trait::async_trait]
// impl ILeaseDBRepository<WsReqInfo> for RedisRepository {}
// #[async_trait::async_trait]
// impl IDBRepository<WsReqInfo> for RedisRepository {}
// #[async_trait::async_trait]
// impl ILeaseRepository<WsReqInfo> for RedisRepository {
//     async fn update_with_lease(
//         &self,
//         _key: &str,
//         _entity: WsReqInfo,
//         _ttl: i64,
//     ) -> anyhow::Result<WsReqInfo> {
//         unimplemented!()
//     }
//     async fn insert_with_lease(
//         &self,
//         key: &str,
//         entity: WsReqInfo,
//         ttl: i64,
//     ) -> anyhow::Result<WsReqInfo> {
//         let mut con = self.client.get_async_connection().await?;
//         con.pset_ex(
//             format!("{WS_FILE_PREFIX}{key}"),
//             serde_json::to_string(&entity).unwrap(),
//             ttl.try_into().unwrap(),
//         )
//         .await?;
//         Ok(entity)
//     }
//     async fn keep_alive(&self, _key: &str) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
// }
// #[async_trait::async_trait]
// impl IReadOnlyRepository<WsReqInfo> for RedisRepository {
//     async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WsReqInfo> {
//         let mut connection = self.client.get_async_connection().await?;
//         let result = connection
//             .get::<String, Option<String>>(format!("{WS_FILE_PREFIX}{uuid}"))
//             .await?
//             .ok_or(anyhow!("No such wsfile key: {uuid}"))?;
//         let ws_file_info = serde_json::from_str::<WsReqInfo>(&result)?;
//         Ok(ws_file_info)
//     }
//     async fn get_all(&self) -> anyhow::Result<Vec<WsReqInfo>> {
//         unimplemented!()
//     }
// }
// #[async_trait::async_trait]
// impl IMutableRepository<WsReqInfo> for RedisRepository {
//     async fn update(&self, _entity: WsReqInfo) -> anyhow::Result<WsReqInfo> {
//         unimplemented!()
//     }
//     async fn insert(&self, _entity: WsReqInfo) -> anyhow::Result<WsReqInfo> {
//         unimplemented!()
//     }
//     async fn delete(&self, _entity: WsReqInfo) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
//     async fn delete_by_id(&self, uuid: &str, _entity: Option<WsReqInfo>) -> anyhow::Result<bool> {
//         let mut connection = self.client.get_async_connection().await?;
//         connection.del(format!("{WS_FILE_PREFIX}{uuid}")).await?;
//         Ok(true)
//     }
//     async fn save_changed(&self) -> anyhow::Result<bool> {
//         unimplemented!()
//     }
// }

// fn id_hash_key(id: &str, hash: &str) -> String {
//     format!("partials_{}_{}", id, hash)
// }

// fn id_key(id: &str) -> String {
//     format!("partials_{}*", id)
// }

// fn hash_key(hash: &str) -> String {
//     format!("partials_*_{}", hash.to_ascii_uppercase())
// }

// #[async_trait::async_trait]
// impl IReadOnlyRepository<TextStorage> for RedisRepository {
//     /// 根据 uuid 获取唯一对象
//     async fn get_by_id(&self, uuid: &str) -> anyhow::Result<TextStorage> {
//         let mut connection = self.client.get_async_connection().await?;
//         let result: Option<String> = connection.get(format!("{TEXT_KEY_PREFIX}{uuid}")).await?;
//         Ok(TextStorage {
//             key: Some(Uuid::from_str(uuid)?),
//             value: result.ok_or(anyhow::anyhow!("No such text key!"))?,
//         })
//     }
//     /// 获取所有对象
//     async fn get_all(&self) -> anyhow::Result<Vec<TextStorage>> {
//         unimplemented!()
//     }
// }

// /// 可变仓储，对修改数据的仓储进行抽象
// #[async_trait::async_trait]
// impl IMutableRepository<TextStorage> for RedisRepository {
//     /// 更新数据
//     async fn update(&self, entity: TextStorage) -> anyhow::Result<TextStorage> {
//         let mut connection = self.client.get_async_connection().await?;
//         let result = entity.clone();
//         connection
//             .getset(
//                 format!(
//                     "{TEXT_KEY_PREFIX}{}",
//                     entity
//                         .key
//                         .ok_or(anyhow::anyhow!("No such text key!"))?
//                         .to_string()
//                 ),
//                 entity.value,
//             )
//             .await?;
//         Ok(result)
//     }
//     /// 插入数据
//     async fn insert(&self, entity: TextStorage) -> anyhow::Result<TextStorage> {
//         let mut connection = self.client.get_async_connection().await?;
//         let mut result = entity.clone();

//         let already_key = self.text_already_uuid(&entity.value).await?;
//         result.key = entity.key.or(already_key).or(Some(uuid::Uuid::new_v4()));
//         connection
//             .set(
//                 format!(
//                     "{TEXT_KEY_PREFIX}{}",
//                     result.key.as_ref().unwrap().to_string()
//                 ),
//                 entity.value,
//             )
//             .await?;
//         Ok(result)
//     }
//     /// 删除数据
//     async fn delete(&self, entity: TextStorage) -> anyhow::Result<bool> {
//         self.delete_by_id(
//             entity
//                 .key
//                 .ok_or(anyhow::anyhow!("No such text key!"))?
//                 .to_string()
//                 .as_str(),
//             Option::<TextStorage>::None,
//         )
//         .await?;
//         Ok(true)
//     }
//     /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
//     /// 但对于大多数数据库可尝试使用以下代码：
//     /// ``` no_run
//     /// // 建立一个空的枚举用于指示类型
//     /// let n: Option<TYPE> = None;
//     /// self.delete_by_id(entity.id.as_str(), n).await?;
//     /// ```
//     async fn delete_by_id(&self, uuid: &str, _entity: Option<TextStorage>) -> anyhow::Result<bool> {
//         let mut connection = self.client.get_async_connection().await?;
//         connection.del(format!("{TEXT_KEY_PREFIX}{uuid}")).await?;
//         Ok(true)
//     }
//     /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
//     ///
//     /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
//     ///
//     async fn save_changed(&self) -> anyhow::Result<bool> {
//         Ok(true)
//     }
// }

// impl IDBRepository<TextStorage> for RedisRepository {}

// #[async_trait::async_trait]
// impl ITextStorageRepository for RedisRepository {
//     async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(String, String)>> {
//         let mut connection = self.client.get_async_connection().await?;
//         let keys = ids
//             .iter()
//             .map(|el| format!("{TEXT_KEY_PREFIX}{el}"))
//             .collect::<Vec<_>>();
//         let mut values = vec![];
//         if keys.len() == 1 {
//             values = vec![
//                 connection
//                     .get::<String, String>(keys.get(0).unwrap().to_owned())
//                     .await?,
//             ];
//         } else if !keys.is_empty() {
//             values = connection.get::<Vec<String>, Vec<String>>(keys).await?;
//         }
//         Ok(ids
//             .iter()
//             .zip(values)
//             .map(|(k, v)| (k.to_string(), v))
//             .collect::<Vec<_>>())
//     }
//     async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>> {
//         let mut connection = self.client.get_async_connection().await?;
//         let keys = connection
//             .keys::<String, Vec<String>>(format!("{TEXT_KEY_PREFIX}*"))
//             .await?;
//         let mut values = vec![];
//         if keys.len() == 1 {
//             values = vec![
//                 connection
//                     .get::<String, String>(keys.get(0).unwrap().to_owned())
//                     .await?,
//             ];
//         } else if !keys.is_empty() {
//             values = connection
//                 .get::<Vec<String>, Vec<String>>(keys.to_owned())
//                 .await?;
//         }
//         let already_kv = keys.iter().zip(values).find(|(_, value)| value.eq(&text));
//         Ok(match already_kv {
//             Some((k, _)) => Some(uuid::Uuid::from_str(
//                 k.split(TEXT_KEY_PREFIX).nth(1).unwrap(),
//             )?),
//             None => None,
//         })
//     }
// }

// #[async_trait::async_trait]
// impl IReadOnlyRepository<FileShards> for RedisRepository {
//     async fn get_by_id(&self, uuid: &str) -> anyhow::Result<FileShards> {
//         let mut con = self.client.get_async_connection().await?;
//         let key = id_key(uuid);
//         let r = con.keys::<String, Vec<String>>(key).await?;
//         let key = r
//             .get(0)
//             .ok_or(anyhow::anyhow!("No such key with id: {uuid}"))?;
//         let file_shards: Option<String> = con.get(key).await?;
//         match file_shards {
//             Some(el) => Ok(serde_json::from_str::<FileShards>(&el).unwrap()),
//             None => anyhow::bail!("Found no such file_shards id"),
//         }
//     }
//     async fn get_all(&self) -> anyhow::Result<Vec<FileShards>> {
//         unimplemented!()
//     }
// }

// #[async_trait::async_trait]
// impl IMutableRepository<FileShards> for RedisRepository {
//     async fn update(&self, _entity: FileShards) -> anyhow::Result<FileShards> {
//         unimplemented!();
//     }
//     async fn insert(&self, _entity: FileShards) -> anyhow::Result<FileShards> {
//         unimplemented!();
//     }
//     async fn delete(&self, entity: FileShards) -> anyhow::Result<bool> {
//         let mut con = self.client.get_async_connection().await?;

//         let id = entity.meta_id;
//         let key = id_key(id.to_string().as_str());
//         let r = con.keys::<String, Vec<String>>(key).await?;
//         let key = r
//             .get(0)
//             .ok_or(anyhow::anyhow!("No such key with id:{id}"))?;

//         let status: bool = con.del(key).await?;
//         Ok(status)
//     }
//     async fn delete_by_id(&self, _uuid: &str, _entity: Option<FileShards>) -> anyhow::Result<bool> {
//         unimplemented!();
//     }
//     async fn save_changed(&self) -> anyhow::Result<bool> {
//         unimplemented!();
//     }
// }

// #[async_trait::async_trait]
// impl ILeaseRepository<FileShards> for RedisRepository {
//     /// 更新数据并更新租约
//     async fn update_with_lease(
//         &self,
//         key: &str,
//         entity: FileShards,
//         ttl: i64,
//     ) -> anyhow::Result<FileShards> {
//         let mut con = self.client.get_async_connection().await?;
//         let key = id_hash_key(key, &entity.hash);
//         let r: i64 = con.ttl(key.to_owned()).await?;
//         if r == -2 {
//             anyhow::bail!("The key has been deleted or expired.")
//         }
//         con.set(key.to_owned(), serde_json::to_string(&entity).unwrap())
//             .await?;
//         let new = r + ttl;
//         con.pset_ex(
//             key.to_owned(),
//             serde_json::to_string(&entity).unwrap(),
//             new.try_into().unwrap(),
//         )
//         .await?;
//         Ok(entity)
//     }
//     /// 插入数据并设定租约
//     async fn insert_with_lease(
//         &self,
//         key: &str,
//         entity: FileShards,
//         ttl: i64,
//     ) -> anyhow::Result<FileShards> {
//         let mut con = self.client.get_async_connection().await?;
//         let key = id_hash_key(key, &entity.hash);
//         let hash_key = hash_key(&entity.hash);
//         let id_key = id_key(&entity.meta_id.to_string());
//         let r = con.keys::<String, Vec<String>>(hash_key).await?;
//         let r2 = con.keys::<String, Vec<String>>(id_key).await?;
//         let already = r.get(0);
//         let already2 = r2.get(0);
//         match already {
//             None => match already2 {
//                 None => {
//                     con.pset_ex(
//                         key,
//                         serde_json::to_string(&entity).unwrap(),
//                         ttl.try_into().unwrap(),
//                     )
//                     .await?;
//                 }
//                 Some(_) => {
//                     anyhow::bail!("id conflict");
//                 }
//             },
//             Some(_) => {
//                 anyhow::bail!("hash conflict");
//             }
//         }

//         Ok(entity)
//     }
//     /// 延长特定数据的租约
//     async fn keep_alive(&self, _key: &str) -> anyhow::Result<bool> {
//         unimplemented!();
//     }
// }

// impl IDBRepository<FileShards> for RedisRepository {}

// #[async_trait::async_trait]
// impl ILeaseDBRepository<FileShards> for RedisRepository {}

// #[async_trait::async_trait]
// impl IMultipartRepo for RedisRepository {
//     /// 根据 file_metadata hash 值取得一条记录
//     async fn get_by_hash(&self, hash: &str) -> anyhow::Result<Option<FileShards>> {
//         let mut con = self.client.get_async_connection().await?;
//         let key = hash_key(hash);
//         let r = con.keys::<String, Vec<String>>(key).await?;
//         let key = match r.get(0) {
//             Some(key) => key,
//             None => return Ok(None),
//         };
//         let file_shards: Option<String> = con.get(key).await?;
//         Ok(match file_shards {
//             Some(el) => Some(serde_json::from_str::<FileShards>(&el)?),
//             None => None,
//         })
//     }
//     /// 上传文件分片
//     async fn upload_shard(&self, file_metadata_id: Uuid, data: FileShard) -> anyhow::Result<()> {
//         let mut bin = data.bin.as_slice();
//         let nth = data.nth;
//         let temp_path = &self.temp_dir;
//         let path = Path::new(temp_path).join(format!("{file_metadata_id}_{nth}"));

//         tokio::fs::create_dir_all(temp_path).await?;
//         let mut file = match tokio::fs::File::create(path).await {
//             Ok(op) => op,
//             Err(e) => {
//                 anyhow::bail!(e)
//             }
//         };
//         tokio::io::copy(&mut bin, &mut file).await?;
//         Ok(())
//     }
//     /// 整合文件分片并返回整个文件
//     async fn complete_shards(&self, file_metadata_id: Uuid) -> anyhow::Result<Vec<u8>> {
//         let mut file_shards: FileShards = self.get_by_id(&file_metadata_id.to_string()).await?;
//         let origin_hash = &file_shards.hash;
//         let temp_path = &self.temp_dir;
//         let mut dir = tokio::fs::read_dir(temp_path).await?;
//         let mut paths = vec![];
//         while let Ok(el) = dir.next_entry().await {
//             if let Some(el2) = el {
//                 let file_name = el2.file_name().into_string().unwrap();
//                 if file_name.contains(&file_metadata_id.to_string()) {
//                     paths.push(el2.path());
//                 }
//             } else {
//                 break;
//             }
//         }
//         paths.sort_by(|a, b| {
//             let a_file_name = a.file_name().unwrap().to_str().unwrap();
//             let a_nth: usize = a_file_name.rsplit('_').next().unwrap().parse().unwrap();
//             let b_file_name = b.file_name().unwrap().to_str().unwrap();
//             let b_nth: usize = b_file_name.rsplit('_').next().unwrap().parse().unwrap();
//             a_nth.cmp(&b_nth)
//         });
//         let mut content = vec![];

//         for path in paths.iter() {
//             content.append(&mut tokio::fs::read(path).await?);
//         }
//         let completed_hash = blake3::hash(&content).to_string().to_uppercase();
//         if !origin_hash.eq_ignore_ascii_case(&completed_hash) {
//             file_shards.is_upload_failed = true;
//             file_shards.failed_reason =
//                 Some(format!("Different hash between origin and completed.  origin: {origin_hash} completed: {completed_hash}"));
//             self.update_with_lease(
//                 &file_metadata_id.to_string(),
//                 file_shards.to_owned(),
//                 1200000,
//             )
//             .await?;
//             anyhow::bail!(
//                 "Wrong completed hash: origin: {origin_hash} completed: {completed_hash}."
//             );
//         };

//         Ok(content)
//     }

//     async fn remove_shards_files(&self, file_metadata_id: Uuid) -> anyhow::Result<()> {
//         let temp_path = &self.temp_dir;
//         let mut dir = tokio::fs::read_dir(temp_path)
//             .await
//             .map_err(|e| anyhow::anyhow!("NODIR: {e}"))?;
//         while let Ok(el) = dir.next_entry().await {
//             if let Some(el2) = el {
//                 let file_name = el2.file_name().into_string().unwrap();
//                 if file_name.contains(&file_metadata_id.to_string()) {
//                     tokio::fs::remove_file(el2.path()).await?;
//                 }
//             } else {
//                 break;
//             }
//         }
//         Ok(())
//     }
// }
