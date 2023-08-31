use alice_architecture::utils::*;

/// 已安装软件仓储接口
#[async_trait]
pub trait InstalledSoftwareRepo: Send + Sync {
    /// 检查用例执行所需的软件是否满足
    ///
    /// # 参数
    ///
    /// * `software_name` - Spack 安装软件名称
    /// * `required_install_arguments` - 用例执行需要的 Spack 安装软件参数
    async fn is_software_satisfied(
        &self,
        software_name: &str,
        required_install_arguments: &[String],
    ) -> anyhow::Result<bool>;
}
