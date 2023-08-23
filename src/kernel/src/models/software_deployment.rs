use alice_architecture::model::IAggregateRoot;
use serde::*;

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct SoftwareSource {
    id: String,
    r#type: String,
    url: String,
    username: String,
    password: String,
}

impl IAggregateRoot for SoftwareSource {}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct SoftwareInstallHistory {
    id: String,
    name: String,
    status: i32,
    log: String,
    end_time: chrono::DateTime<chrono::Utc>,
    request_user_id: String,
}
impl IAggregateRoot for SoftwareInstallHistory {}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct SoftwareBlockList {
    id: String,
    name: String,
    version: String,
}
impl IAggregateRoot for SoftwareBlockList {}

/// 已安装的软件
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
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
impl IAggregateRoot for InstalledSoftware {}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct Software {
    id: String,
    name: String,
    version: String,
    software_install_argument: String,
}
impl IAggregateRoot for Software {}
