use alice_architecture::model::derive::AggregateRoot;
use serde::*;

#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
pub struct SoftwareSource {
    id: String,
    r#type: String,
    url: String,
    username: String,
    password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
pub struct SoftwareInstallHistory {
    id: String,
    name: String,
    status: i32,
    log: String,
    end_time: chrono::DateTime<chrono::Utc>,
    request_user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
pub struct SoftwareBlockList {
    id: String,
    name: String,
    version: String,
}

/// 已安装的软件
#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
pub struct InstalledSoftware {
    /// id
    id: String,
    /// 安装源 id
    source_id: String,
    /// 软件 id
    software_id: String,
    /// 软件 spack 名称
    software_name: String,
    /// spack 安装参数
    install_arguments: Vec<String>,
    /// 发起安装的用户
    installed_user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
pub struct Software {
    id: String,
    name: String,
    version: String,
    software_install_argument: String,
}
