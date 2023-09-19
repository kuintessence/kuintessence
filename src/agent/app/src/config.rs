use serde::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(default = "AgentConfig::default_report_url")]
    pub report_url: String,
    #[serde(default = "AgentConfig::default_save_path")]
    pub save_path: String,
    #[serde(default = "AgentConfig::default_save_path")]
    pub container_save_path: String,
    #[serde(default = "AgentConfig::default_include_env_script_path")]
    pub include_env_script_path: String,
    #[serde(default = "Default::default")]
    pub include_env_script: String,
    #[serde(default = "Default::default")]
    pub watch_interval: u64,
    #[serde(default = "Default::default")]
    pub upload_base_url: String,
    #[serde(default = "Default::default")]
    pub download_base_url: String,
    #[serde(default = "Default::default")]
    pub scheduler: SchedulerConfig,
    #[serde(default = "Default::default")]
    pub ssh_proxy: Option<SshProxyConfig>,
    #[serde(default = "Default::default")]
    pub login: LoginConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulerConfig {
    #[serde(default = "SchedulerConfig::default_type")]
    pub r#type: String,
    #[serde(default = "Default::default")]
    pub queue: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshProxyConfig {
    pub host: String,
    pub username: String,
    #[serde(default = "SshProxyConfig::default_port")]
    pub port: u16,
    #[serde(default = "SshProxyConfig::default_home_dir")]
    pub home_dir: String,
    #[serde(default = "SshProxyConfig::default_save_dir")]
    pub save_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LoginConfig {
    pub url: String,
    pub client_id: String,
    pub token_url: String,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            report_url: Self::default_report_url(),
            save_path: Self::default_save_path(),
            include_env_script_path: Self::default_include_env_script_path(),
            include_env_script: Default::default(),
            watch_interval: Self::default_watch_interval(),
            upload_base_url: Self::default_upload_base_url(),
            download_base_url: Self::default_upload_base_url(),
            container_save_path: Self::default_save_path(),
            scheduler: Default::default(),
            ssh_proxy: Default::default(),
            login: Default::default(),
        }
    }
}

impl AgentConfig {
    pub fn default_report_url() -> String {
        "http://localhost/report".to_string()
    }
    pub fn default_save_path() -> String {
        ".".to_string()
    }
    pub fn default_include_env_script_path() -> String {
        "included.sh".to_string()
    }
    pub fn default_watch_interval() -> u64 {
        300
    }
    pub fn default_upload_base_url() -> String {
        "http://localhost/upload".to_string()
    }
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            r#type: Self::default_type(),
            queue: None,
        }
    }
}

impl SchedulerConfig {
    pub fn default_type() -> String {
        "slurm".to_string()
    }
}

impl Default for SshProxyConfig {
    fn default() -> Self {
        Self {
            host: Default::default(),
            username: Default::default(),
            port: Self::default_port(),
            home_dir: Self::default_home_dir(),
            save_dir: Self::default_save_dir(),
        }
    }
}

impl SshProxyConfig {
    pub fn default_port() -> u16 {
        22
    }
    pub fn default_home_dir() -> String {
        "~".to_string()
    }
    pub fn default_save_dir() -> String {
        "agent/tasks".to_string()
    }
}
