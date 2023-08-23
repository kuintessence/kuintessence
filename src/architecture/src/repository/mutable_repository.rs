/// 可变仓储，对修改数据的仓储进行抽象
#[async_trait::async_trait]
pub trait IMutableRepository<T>
where
    T: std::marker::Send + crate::model::IAggregateRoot,
{
    /// 更新数据
    async fn update(&self, entity: T) -> anyhow::Result<T>;
    /// 插入数据
    async fn insert(&self, entity: T) -> anyhow::Result<T>;
    /// 删除数据
    async fn delete(&self, entity: T) -> anyhow::Result<bool>;
    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(&self, uuid: &str, entity: Option<T>) -> anyhow::Result<bool>;
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool>;
}
