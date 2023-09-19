use domain::{
    model::entity::{task::DeployerType, SoftwareInstallOptions},
    service::SoftwareDeployerService,
};
use tokio::process::Command;

pub struct ApptainerDeployer {
    execution_path: String,
    save_path: String,
    apptainer_proxy: Option<String>,
    ssh_proxy: Option<crate::config::SshProxyConfig>,
}

#[async_trait::async_trait]
impl SoftwareDeployerService for ApptainerDeployer {
    async fn install(&self, name: &str, parameters: Vec<String>) -> anyhow::Result<String> {
        self.install_from_commandline(name, parameters).await
    }
    async fn uninstall(&self, hash: &str) -> anyhow::Result<()> {
        let path = format!("{}/{hash}", self.save_path);
        let path = std::path::Path::new(path.as_str());
        if path.exists() {
            tokio::fs::remove_file(path).await?;
        }
        Ok(())
    }
    async fn load_installed(&self) -> anyhow::Result<Vec<SoftwareInstallOptions>> {
        let mut ls = tokio::fs::read_dir(self.save_path.as_str()).await?;
        let mut result = vec![];
        while let Some(dir) = ls.next_entry().await? {
            let dir_path = dir.path();
            let dir_name = dir.file_name();
            let mut inner_ls = tokio::fs::read_dir(&dir_path).await?;
            if dir_path.is_dir() {
                while let Some(file) = inner_ls.next_entry().await? {
                    let file_path = file.path();
                    let file_name = file.file_name();
                    if file_path.is_file() {
                        let file_name = file_name.to_string_lossy();
                        if file_name.ends_with(".sif") {
                            result.push(SoftwareInstallOptions {
                                parameters: vec![],
                                version: file_name.replace(".sif", ""),
                                name: dir_name.to_string_lossy().to_string(),
                            });
                        }
                    }
                }
            }
        }
        Ok(result)
    }
    fn gen_load_script(&self, hash: &str) -> String {
        let execution_path = self.execution_path.as_str();
        format!("{execution_path} run {hash} \\")
    }
    async fn find_installed_hash(
        &self,
        name: &str,
        parameters: &[String],
    ) -> anyhow::Result<Option<String>> {
        let mut path = std::path::PathBuf::new();
        path.push(self.save_path.as_str());
        path.push(name);
        if !path.exists() {
            return Ok(None);
        }
        let parameters = parameters.join("");
        path.push(format!("{parameters}.sif"));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(path.to_string_lossy().to_string()))
    }
    fn get_deployer_type(&self) -> DeployerType {
        DeployerType::Apptainer
    }
}

impl ApptainerDeployer {
    pub fn new(
        execution_path: String,
        save_path: String,
        apptainer_proxy: Option<String>,
        ssh_proxy: Option<crate::config::SshProxyConfig>,
    ) -> Self {
        Self {
            execution_path,
            save_path,
            apptainer_proxy,
            ssh_proxy,
        }
    }
    async fn install_from_commandline(
        &self,
        name: &str,
        parameters: Vec<String>,
    ) -> anyhow::Result<String> {
        let mut path = std::path::PathBuf::new();
        path.push(self.save_path.as_str());
        path.push(name);
        if !path.exists() {
            tokio::fs::create_dir_all(path).await?;
        }
        let parameters = parameters.join("");
        let docker_url = match &self.apptainer_proxy {
            Some(x) => format!("docker://{x}/{name}:{parameters}"),
            None => format!("docker://{name}:{parameters}"),
        };
        let output = Command::new(self.execution_path.as_str())
            .arg("pull")
            .arg(format!("{}/{name}/{parameters}.sif", self.save_path))
            .arg(docker_url)
            .output()
            .await
            .map_err(|e| {
                anyhow::anyhow!("Unable to run apptainer pull because: {}", e.to_string())
            })?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(output.stderr.as_slice()))
        }
        let hash = String::from_utf8_lossy(output.stdout.as_slice()).to_string();
        let hash = hash.trim().rsplit_once('-').unwrap().1;
        Ok(hash.to_string())
    }
}
