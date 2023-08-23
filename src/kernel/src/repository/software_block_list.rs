use crate::prelude::*;

/// 软件黑名单列表
#[async_trait]
pub trait ISoftwareBlockListRepository {
    /// 检查软件版本是否在黑名单中
    ///
    /// # 参数
    ///
    /// * `software_name` - Spack 安装软件名称
    /// * `version` - Spack 安装软件版本
    async fn is_software_version_blocked(
        &self,
        software_name: &str,
        version: &str,
    ) -> anyhow::Result<bool>;
}
