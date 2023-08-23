use agent_core::{
    models::{DeployerType, SoftwareInstallOptions},
    services::ISoftwareDeployerService,
};
use serde::*;
use std::collections::HashMap;
use tokio::process::Command;

pub struct SpackDeployer {
    line_capture: regex::Regex,
    paramter_capture: regex::Regex,
    ssh_proxy: Option<crate::config::SshProxyConfig>,
}

#[async_trait::async_trait]
impl ISoftwareDeployerService for SpackDeployer {
    async fn install(&self, name: &str, parameters: Vec<String>) -> anyhow::Result<String> {
        let paramters = parameters.join("").to_string();
        let output = Command::new("spack")
            .arg("install")
            .arg("-y")
            .arg("--fail-fast")
            .arg(format!("{name}{paramters}"))
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("Unable to run spack because: {}", e.to_string()))?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(output.stderr.as_slice()))
        }
        let hash = String::from_utf8_lossy(output.stdout.as_slice()).to_string();
        let hash = hash.trim().rsplit_once('-').unwrap().1;
        Ok(hash.to_string())
    }
    async fn uninstall(&self, hash: &str) -> anyhow::Result<()> {
        let output = Command::new("spack")
            .arg("uninstall")
            .arg(format!("/{hash}"))
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("Unable to run spack because: {}", e.to_string()))?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(output.stderr.as_slice()))
        }
        Ok(())
    }
    async fn load_installed(&self) -> anyhow::Result<Vec<SoftwareInstallOptions>> {
        match self.load_installed_from_json().await {
            Ok(x) => Ok(x),
            Err(_) => self.load_installed_from_lines().await,
        }
    }
    fn gen_load_script(&self, hash: &str) -> anyhow::Result<String> {
        Ok(format!("spack load /{hash}"))
    }
    async fn find_installed_hash(
        &self,
        name: &str,
        parameters: &[String],
    ) -> anyhow::Result<Option<String>> {
        match self.find_installed_hash_from_json(name, parameters).await {
            Ok(x) => Ok(x.get(0).cloned()),
            Err(_) => {
                Ok(self.find_installed_hash_from_lines(name, parameters).await?.get(0).cloned())
            }
        }
    }
    fn get_deployer_type(&self) -> DeployerType {
        DeployerType::Spack
    }
}

impl SpackDeployer {
    pub fn new(ssh_proxy: Option<crate::config::SshProxyConfig>) -> Self {
        Self {
            line_capture: regex::Regex::new(r"(?m)^(?P<hash>\w{32}) (?P<packageName>.+?)@(?P<version>.+?)%(?P<compiler>(?:\w+))(?: (?P<flags>[~|+].+?))?(?: (?P<options>.+?))?$").unwrap(),
            paramter_capture: regex::Regex::new(r"[+](?P<name>[^+~]+)").unwrap(),
            ssh_proxy
        }
    }
    async fn load_installed_from_json(&self) -> anyhow::Result<Vec<SoftwareInstallOptions>> {
        let output = Command::new("spack")
            .arg("find")
            .arg("--json")
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("Unable to run spack because: {}", e.to_string()))?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(output.stderr.as_slice()))
        }
        let result: Vec<SpackSpec> = serde_json::from_reader(output.stdout.as_slice())?;
        Ok(result.iter().cloned().map(|x| x.into()).collect())
    }
    async fn load_installed_from_lines(&self) -> anyhow::Result<Vec<SoftwareInstallOptions>> {
        let output = Command::new("spack")
            .arg("find")
            .arg("-L")
            .arg("-v")
            .arg("-f")
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("Unable to run spack because: {}", e.to_string()))?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(output.stderr.as_slice()))
        }
        let text = String::from_utf8_lossy(output.stdout.as_slice()).to_string();
        let iter = self.line_capture.captures_iter(text.as_str());
        Ok(iter
            .map(|x| SoftwareInstallOptions {
                parameters: self
                    .paramter_capture
                    .captures_iter(x.name("flags").unwrap().as_str())
                    .map(|x| x.name("name").unwrap().as_str().to_string())
                    .collect(),
                version: x.name("version").unwrap().as_str().to_string(),
                name: x.name("packageName").unwrap().as_str().to_string(),
            })
            .collect())
    }
    async fn find_installed_hash_from_json(
        &self,
        name: &str,
        parameters: &[String],
    ) -> anyhow::Result<Vec<String>> {
        let paramters = parameters.join("").to_string();
        let output = Command::new("spack")
            .arg("find")
            .arg("--json")
            .arg(format!("{name}{paramters}"))
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("Unable to run spack because: {}", e.to_string()))?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(output.stderr.as_slice()))
        }
        let result: Vec<SpackSpec> = serde_json::from_reader(output.stdout.as_slice())?;
        Ok(result.iter().cloned().map(|x| x.hash).collect())
    }
    async fn find_installed_hash_from_lines(
        &self,
        name: &str,
        parameters: &[String],
    ) -> anyhow::Result<Vec<String>> {
        let paramters = parameters.join("").to_string();
        let output = Command::new("spack")
            .arg("find")
            .arg("-L")
            .arg("-v")
            .arg("-f")
            .arg(format!("{name}{paramters}"))
            .output()
            .await
            .map_err(|e| anyhow::anyhow!("Unable to run spack because: {}", e.to_string()))?;
        if !output.status.success() {
            anyhow::bail!("{}", String::from_utf8_lossy(output.stderr.as_slice()))
        }
        let text = String::from_utf8_lossy(output.stdout.as_slice()).to_string();
        let iter = self.line_capture.captures_iter(text.as_str());
        Ok(iter.filter_map(|x| x.name("hash")).map(|x| x.as_str().to_string()).collect())
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpackSpec {
    pub name: String,
    pub version: String,
    pub compiler: SpackSpecCompiler,
    pub paramters: SpackSpecParamters,
    pub hash: String,
}

impl From<SpackSpec> for SoftwareInstallOptions {
    fn from(val: SpackSpec) -> Self {
        SoftwareInstallOptions {
            parameters: val
                .paramters
                .flags
                .iter()
                .filter_map(|(k, &v)| if v { Some(k.clone()) } else { None })
                .collect(),
            version: val.version,
            name: val.name,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpackSpecParamters {
    #[serde(flatten)]
    pub flags: HashMap<String, bool>,
    pub cflags: Vec<String>,
    pub cppflags: Vec<String>,
    pub cxxflags: Vec<String>,
    pub fflags: Vec<String>,
    pub ldflags: Vec<String>,
    pub ldlibs: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpackSpecCompiler {
    pub name: String,
    pub version: String,
}
