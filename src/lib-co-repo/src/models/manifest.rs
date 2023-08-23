use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// 标准描述清单
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// 能力种类
    pub ability: AbilityKind,
    /// 展示名称
    pub name: String,
    /// 系统名称
    pub system_name: String,
    /// 内容能力种类
    /// 内容实体版本号
    pub version: String,
    /// 维护者列表
    pub maintainers: Vec<String>,
    /// git 地址
    pub git: Option<String>,
    /// 主页
    pub home_page: Option<String>,
}

/// 内容能力种类
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub enum AbilityKind {
    /// 软件功能计算能力
    SoftwareComputing(
        /// 软件功能计算能力包种类
        SoftwareComputingRepo,
    ),
}

/// 软件功能计算能力包种类
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
pub enum SoftwareComputingRepo {
    /// 软件描述包
    Software,
    /// 用例描述包
    #[serde(rename_all = "camelCase")]
    Usecase {
        /// 依赖的系统名称
        dependency_system_name: String,
        /// 依赖的版本范围
        dependency_version_range: String,
    },
}
