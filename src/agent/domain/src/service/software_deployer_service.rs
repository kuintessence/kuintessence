use crate::model::entity::{task::DeployerType, SoftwareInstallOptions};

#[async_trait::async_trait]
pub trait SoftwareDeployerService: Send + Sync {
    async fn install(&self, name: &str, parameters: Vec<String>) -> anyhow::Result<String>;
    async fn uninstall(&self, hash: &str) -> anyhow::Result<()>;
    async fn load_installed(&self) -> anyhow::Result<Vec<SoftwareInstallOptions>>;
    async fn find_installed_hash(
        &self,
        name: &str,
        parameters: &[String],
    ) -> anyhow::Result<Option<String>>;
    fn gen_load_script(&self, hash: &str) -> String;
    fn get_deployer_type(&self) -> DeployerType {
        DeployerType::Unknown
    }
}
