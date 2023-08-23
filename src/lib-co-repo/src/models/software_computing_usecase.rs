use crate::{dtos::prelude::Packages, prelude::*};
use uuid::Uuid;

/// 软件用例节点解析所需数据
pub struct SoftwareComputingUsecase {
    /// 用例包 id
    pub usecase_version_id: Uuid,
    /// 软件包 id
    pub software_version_id: Uuid,
    /// 用例规格
    pub usecase_spec: UsecaseSpec,
    /// 软件规格
    pub software_spec: SoftwareSpec,
    /// 参数材料列表
    pub arguments: Vec<Argument>,
    /// 环境变量材料列表
    pub environments: Vec<Environment>,
    /// 直接输入文件材料列表
    pub filesome_inputs: Vec<FilesomeInput>,
    /// 结果收集材料列表
    pub collected_outs: Vec<CollectedOut>,
    /// 输出文件材料列表
    pub filesome_outputs: Vec<FilesomeOutput>,
    /// 模板文件路径内容列表
    pub template_file_infos: Vec<TemplateFileInfo>,
}

impl SoftwareComputingUsecase {
    /// 解包形成用例分析数据
    pub fn extract_packages(packages: Packages) -> Self {
        match packages {
            Packages::SoftwareComputing(p1, p2) => {
                let (usecase_version_id, usecase_data) =
                    p1.usecase_package_data().or(p2.usecase_package_data()).unwrap();

                let (software_version_id, software_data) =
                    p1.software_package_data().or(p2.software_package_data()).unwrap();

                Self {
                    usecase_version_id,
                    software_version_id,
                    usecase_spec: usecase_data.spec,
                    software_spec: software_data.spec,
                    arguments: software_data.arguments,
                    environments: software_data.environments,
                    filesome_inputs: software_data.filesome_inputs,
                    collected_outs: usecase_data.collected_outs,
                    filesome_outputs: software_data.filesome_outputs,
                    template_file_infos: usecase_data.template_file_infos,
                }
            }
        }
    }
}
