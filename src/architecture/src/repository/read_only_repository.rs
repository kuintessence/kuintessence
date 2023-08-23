/// 只读仓储，对仅限读取的仓储进行抽象
#[async_trait::async_trait]
pub trait IReadOnlyRepository<T>
where
    T: std::marker::Send + crate::model::IAggregateRoot,
{
    /// 根据 uuid 获取唯一对象
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<T>;
    /// 获取所有对象
    async fn get_all(&self) -> anyhow::Result<Vec<T>>;
}
