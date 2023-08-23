use crate::prelude::*;
use alice_architecture::repository::IReadOnlyRepository;

/// 软件黑名单列表
#[async_trait]
pub trait IClusterRepository: IReadOnlyRepository<Cluster> {
    /// 随机获取 Cluster id
    async fn get_random_cluster(&self) -> anyhow::Result<Uuid>;
}
