use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{
    software::{
        materials::{inputs::*, outputs::FilesomeOutput},
        SoftwareSpec,
    },
    usecase::{collected_out::CollectedOut, spec::UsecaseSpec},
};
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase", untagged)]
/// 材料 json schema
pub enum MaterialSchema {
    Software(SoftwareMaterial),
    Usecase(Box<UsecaseMaterial>),
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, tag = "kind", content = "spec")]
/// 软件材料
pub enum SoftwareMaterial {
    /// 软件规格
    SoftwareSpec(SoftwareSpec),
    /// 参数输入列表
    ArgumentList(Vec<Argument>),
    /// 环境变量输入列表
    EnvironmentList(Vec<Environment>),
    /// 用例默认读取文件列表
    FilesomeInputList(Vec<FilesomeInput>),
    /// 输出使用文件的列表
    FilesomeOutputList(Vec<FilesomeOutput>),
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, tag = "kind", content = "spec")]
/// 用例材料
pub enum UsecaseMaterial {
    /// 用例规格
    UsecaseSpec(Box<UsecaseSpec>),
    CollectedOutList(Vec<CollectedOut>),
}
