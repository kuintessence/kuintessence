/// 租约仓储，对带有租约的仓储进行抽象
#[async_trait::async_trait]
pub trait ILeaseRepository<T>
where
    T: std::marker::Send + crate::model::IAggregateRoot,
{
    /// 更新数据并更新租约
    async fn update_with_lease(&self, key: &str, entity: T, ttl: i64) -> anyhow::Result<T>;
    /// 插入数据并设定租约
    async fn insert_with_lease(&self, key: &str, entity: T, ttl: i64) -> anyhow::Result<T>;
    /// 延长特定数据的租约
    async fn keep_alive(&self, key: &str) -> anyhow::Result<bool>;
}
