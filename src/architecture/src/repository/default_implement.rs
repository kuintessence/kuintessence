#[cfg(feature = "etcd")]
pub mod etcd {
    /// 针对 Etcd 数据库实现租约仓储 `alice_architecture::repository::ILeaseRepository`
    ///
    /// struct 要求带有字段 `client: std::sync::Arc<etcd_client::Client>`
    #[macro_export]
    macro_rules! impl_etcd_lease_repository {
        ($base_struct: ty, $domain: ty) => {
            #[async_trait::async_trait]
            impl ILeaseRepository<$domain> for $base_struct {
                async fn update_with_lease(
                    &self,
                    key: &str,
                    entity: $domain,
                    ttl: i64,
                ) -> anyhow::Result<$domain> {
                    let mut lease_client = self.client.lease_client();
                    let lease_id = lease_client.grant(ttl + 2, None).await?.id();
                    let mut kv_client = self.client.kv_client();
                    let key = format!("alice_{}_{}", stringify!($domain), key);
                    kv_client
                        .put(
                            key,
                            Into::<Vec<u8>>::into(serde_json::to_vec(&entity).unwrap()),
                            Some(etcd_client::PutOptions::new().with_lease(lease_id)),
                        )
                        .await?;
                    Ok(entity)
                }
                async fn insert_with_lease(
                    &self,
                    key: &str,
                    entity: $domain,
                    ttl: i64,
                ) -> anyhow::Result<$domain> {
                    self.update_with_lease(key, entity, ttl).await
                }
                async fn keep_alive(&self, key: &str) -> anyhow::Result<bool> {
                    let mut lease_client = self.client.lease_client();
                    let mut kv_client = self.client.kv_client();
                    let key = format!("alice_{}_{}", stringify!($domain), key);
                    let entity = kv_client.get(key, None).await?;
                    if entity.kvs().len() == 0 {
                        return Ok(false);
                    }
                    lease_client.keep_alive(entity.kvs()[0].lease()).await?;
                    Ok(true)
                }
            }
        };
    }

    /// 针对 Etcd 数据库实现只读仓储 `alice_architecture::repository::IReadOnlyRepository`
    ///
    /// struct 要求带有字段 `client: std::sync::Arc<etcd_client::Client>`
    #[macro_export]
    macro_rules! impl_etcd_read_only_repository {
        ($base_struct: ty, $domain: ty) => {
            #[async_trait::async_trait]
            impl IReadOnlyRepository<$domain> for $base_struct {
                async fn get_by_id(&self, uuid: &str) -> anyhow::Result<$domain> {
                    let mut kv_client = self.client.kv_client();
                    let key = format!("alice_{}_{}", stringify!($domain), uuid);
                    let entity = kv_client.get(key, None).await?;
                    let kvs = entity.kvs();
                    let kv = match kvs.get(0) {
                        Some(x) => x,
                        None => anyhow::bail!("No item! {}", stringify!($domain)),
                    };
                    let result: $domain = serde_json::from_slice(kv.value())?;
                    Ok(result)
                }
                async fn get_all(&self) -> anyhow::Result<Vec<$domain>> {
                    let mut kv_client = self.client.kv_client();
                    let key = format!("alice_{}", stringify!($domain));
                    let entity = kv_client
                        .get(key, Some(etcd_client::GetOptions::new().with_prefix()))
                        .await?;
                    let kvs = entity.kvs();
                    if kvs.len() == 0 {
                        return Ok(vec![]);
                    }
                    Ok(kvs
                        .iter()
                        .map(|x| serde_json::from_slice::<$domain>(x.value()).unwrap())
                        .collect())
                }
            }
        };
    }

    /// 针对 Etcd 数据库实现可变仓储 `alice_architecture::repository::IMutableRepository`
    ///
    /// struct 要求带有字段 `client: std::sync::Arc<etcd_client::Client>`
    #[macro_export]
    macro_rules! impl_etcd_mutable_repository {
        ($base_struct: ty, $domain: ty) => {
            #[async_trait::async_trait]
            impl IMutableRepository<$domain> for $base_struct {
                async fn update(&self, entity: $domain) -> anyhow::Result<$domain> {
                    let mut kv_client = self.client.kv_client();
                    let key = format!("alice_{}_{}", stringify!($domain), entity.id);
                    kv_client
                        .put(
                            key,
                            Into::<Vec<u8>>::into(serde_json::to_vec(&entity).unwrap()),
                            None,
                        )
                        .await?;
                    Ok(entity)
                }
                async fn insert(&self, entity: $domain) -> anyhow::Result<$domain> {
                    self.update(entity).await
                }
                async fn delete(&self, entity: $domain) -> anyhow::Result<bool> {
                    let n: Option<$domain> = None;
                    self.delete_by_id(entity.id.as_str(), n).await
                }
                async fn delete_by_id(
                    &self,
                    uuid: &str,
                    entity: Option<$domain>,
                ) -> anyhow::Result<bool> {
                    let mut kv_client = self.client.kv_client();
                    let key = format!("alice_{}_{}", stringify!($domain), uuid);
                    match kv_client.delete(key, None).await {
                        Ok(x) => Ok(true),
                        Err(e) => anyhow::bail!(e),
                    }
                }
                async fn save_changed(&self) -> anyhow::Result<bool> {
                    Ok(true)
                }
            }
        };
    }

    /// 针对 Etcd 数据库实现数据库仓储 `alice_architecture::repository::IDBRepository`
    ///
    /// struct 要求带有字段 `client: std::sync::Arc<etcd_client::Client>`
    #[macro_export]
    macro_rules! impl_etcd_db_repository {
        ($base_struct: ty, $domain: ty) => {
            impl IDBRepository<$domain> for $base_struct {}
        };
    }

    /// 针对 Etcd 数据库实现带有租约的数据库仓储 `alice_architecture::repository::ILeaseDBRepositor`
    ///
    /// struct 要求带有字段 `client: std::sync::Arc<etcd_client::Client>`
    #[macro_export]
    macro_rules! impl_etcd_lease_db_repository {
        ($base_struct: ty, $domain: ty) => {
            impl ILeaseDBRepository<$domain> for $base_struct {}
        };
    }
}
