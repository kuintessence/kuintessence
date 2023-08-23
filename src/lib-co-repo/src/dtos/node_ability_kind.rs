use crate::prelude::*;
use anyhow::anyhow;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 解析得出计算用例所需要的包数据
#[derive(Debug)]
pub enum Packages {
    /// 软件计算用例，需要用例包和软件包的数据
    SoftwareComputing(Package, Package),
}

/// 节点能力种类
#[derive(Serialize, Deserialize, Debug)]
pub enum NodeAbilityKind {
    /// 软件计算能力
    SoftwareComputing(UsecaseNodeParsing),
}

/// 解析获得软件用例类型的节点所需的数据
#[derive(Serialize, Deserialize, Debug)]
pub struct UsecaseNodeParsing {
    /// 用例包版本 id
    pub usecase_version_id: Uuid,
    /// 软件包版本 id
    pub software_version_id: Uuid,
    /// 用例 spec
    pub usecase_spec: UsecaseSpec,
    /// 默认文件输入列表
    pub filesome_inputs: Vec<FilesomeInput>,
    /// 默认文件输出列表
    pub filesome_outputs: Vec<FilesomeOutput>,
    /// 收集得到的输出列表
    pub collected_outs: Vec<CollectedOut>,
}

impl NodeAbilityKind {
    /// 解包获得节点能力解析所需数据
    pub fn extract_packages(packages: Packages) -> anyhow::Result<Self> {
        match packages {
            Packages::SoftwareComputing(p1, p2) => {
                let (usecase_version_id, usecase_data) = p1.usecase_package_data().ok_or(
                    anyhow!("Package: {} is not usecase package.", p1.version_id),
                )?;

                let (software_version_id, software_data) = p2.software_package_data().ok_or(
                    anyhow!("Package: {} is not software packages.", p2.version_id),
                )?;
                Ok(Self::SoftwareComputing(UsecaseNodeParsing {
                    usecase_version_id,
                    software_version_id,
                    usecase_spec: usecase_data.spec,
                    filesome_inputs: software_data.filesome_inputs,
                    filesome_outputs: software_data.filesome_outputs,
                    collected_outs: usecase_data.collected_outs,
                }))
            }
        }
    }
}
