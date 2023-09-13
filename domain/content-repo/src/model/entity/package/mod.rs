mod manifest;
pub use self::manifest::{AbilityKind, Manifest, SoftwareComputingRepo};

use std::io::{Cursor, Read};
use alice_architecture::model::derive::AggregateRoot;
use anyhow::Context;
use serde::{Deserialize, Serialize};
use tar::Archive;
use uuid::Uuid;

use crate::model::vo::abilities::software_computing::{
    common::{SoftwareMaterial, UsecaseMaterial},
    software::{
        materials::{
            inputs::{Argument, Environment, FilesomeInput},
            outputs::FilesomeOutput,
        },
        SoftwareSpec,
    },
    usecase::{CollectedOut, TemplateFileInfo, UsecaseSpec},
};

/// 包内容对象
#[derive(Debug, AggregateRoot)]
pub struct Package {
    /// 版本 id
    pub version_id: Uuid,
    /// 清单对象
    pub manifest: Manifest,
    /// 数据对象
    pub data: Data,
}

/// 包中的数据对象
#[derive(Debug)]
pub enum Data {
    /// 软件用例计算类型
    SoftwareUsecaseComputing(SoftwareUsecaseComputingData),
}

/// 软件用例计算的数据对象
#[derive(Debug)]
pub enum SoftwareUsecaseComputingData {
    /// 软件包
    Software(SoftwareData),
    /// 用例包
    Usecase(Box<UsecaseData>),
}

/// 用例包数据对象
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsecaseData {
    /// 用例规格
    pub spec: UsecaseSpec,
    /// 用例收集输出
    pub collected_outs: Vec<CollectedOut>,
    /// 用例使用的模板文件信息
    pub template_file_infos: Vec<TemplateFileInfo>,
}

/// 软件包数据对象
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoftwareData {
    /// 软件规格
    pub spec: SoftwareSpec,
    /// 软件包参数材料
    pub arguments: Vec<Argument>,
    /// 软件包环境变量材料
    pub environments: Vec<Environment>,
    /// 默认输入文件材料
    pub filesome_inputs: Vec<FilesomeInput>,
    /// 默认输出文件材料
    pub filesome_outputs: Vec<FilesomeOutput>,
}

/// tar 包根路径祖先数量
const PACKAGE_ANCESTORS_COUNT: usize = 3;
/// 模板文件夹名称
const TEMPLATE_FILE_FOLDER_NAME: &str = "templates";

impl Package {
    /// 解析获得要解析到草稿节点时软件包中的数据对象
    pub fn software_package_data(&self) -> Option<(Uuid, SoftwareData)> {
        match &self.data {
            Data::SoftwareUsecaseComputing(software_data) => match software_data {
                SoftwareUsecaseComputingData::Software(data) => {
                    Some((self.version_id, data.clone()))
                }
                SoftwareUsecaseComputingData::Usecase(..) => None,
            },
        }
    }

    /// 解析获得要解析到草稿节点时用例包中的数据对象
    pub fn usecase_package_data(&self) -> Option<(Uuid, UsecaseData)> {
        match &self.data {
            Data::SoftwareUsecaseComputing(software_data) => match software_data {
                SoftwareUsecaseComputingData::Software(..) => None,
                SoftwareUsecaseComputingData::Usecase(data) => {
                    Some((self.version_id, *data.clone()))
                }
            },
        }
    }
}

impl Package {
    /// 解析包获得包数据
    /// 因为验证包中都做了验证，所以很多地方可以直接 unwrap！
    ///
    /// # 参数
    ///
    /// * `id` - 包版本 id
    /// * `bytes` - 包二进制内容
    pub fn extract_package(id: Uuid, bytes: &[u8]) -> anyhow::Result<Self> {
        let file_stream = Cursor::new(bytes);
        let file_stream2 = file_stream.to_owned();
        let mut tar_files = tar::Archive::new(file_stream);
        let tar_files_2 = tar::Archive::new(file_stream2);

        // 找到清单文件
        let mut manifest_entry = None;
        for entry in tar_files.entries()? {
            let entry = entry?;
            let path = entry.path()?;
            // 因为经过验证，只要是根路径下的 is_file 文件就一定是 manifest
            if entry.header().entry_type().is_file()
                && path.ancestors().count() == PACKAGE_ANCESTORS_COUNT
            {
                manifest_entry = Some(entry);
                break;
            }
        }
        let mut manifest_entry =
            manifest_entry.context(format!("package: {id} has no manifest file!"))?;

        // 清单文件内容
        let mut manifest_content = String::new();
        manifest_entry.read_to_string(&mut manifest_content)?;

        // 反序列化成清单对象
        let manifest = serde_json::from_value::<Manifest>(serde_yaml::from_str::<
            serde_json::Value,
        >(&manifest_content)?)?;

        let data = match manifest.ability {
            AbilityKind::SoftwareComputing(SoftwareComputingRepo::Software) => {
                Self::parse_software_data(tar_files_2)?
            }
            AbilityKind::SoftwareComputing(SoftwareComputingRepo::Usecase { .. }) => {
                Self::parse_usecase_data(tar_files_2)?
            }
        };

        Ok(Self {
            version_id: id,
            manifest,
            data,
        })
    }

    /// 解析得出软件包的数据
    ///
    /// # 参数
    ///
    /// * `data` - tar 包数据
    fn parse_software_data(mut data: Archive<Cursor<&[u8]>>) -> anyhow::Result<Data> {
        let mut spec = None;
        let mut arguments = vec![];
        let mut environments = vec![];
        let mut filesome_inputs = vec![];
        let mut filesome_outputs = vec![];
        for entry in data.entries()? {
            let mut entry = entry?;
            let entry_path = entry.path()?.to_path_buf();
            if entry_path.ancestors().count() > PACKAGE_ANCESTORS_COUNT
                && entry.header().entry_type().is_file()
            {
                let mut material_content = String::new();
                entry.read_to_string(&mut material_content)?;
                let material_contents = material_content.split("---").collect::<Vec<_>>();

                for material_content in material_contents {
                    let material_content = material_content.trim_end();
                    let material =
                        serde_json::from_value::<SoftwareMaterial>(serde_yaml::from_str::<
                            serde_json::Value,
                        >(
                            material_content
                        )?)?;

                    match material {
                        SoftwareMaterial::SoftwareSpec(el) => spec = Some(el),
                        SoftwareMaterial::ArgumentList(el) => arguments.extend(el),
                        SoftwareMaterial::EnvironmentList(el) => environments.extend(el),
                        SoftwareMaterial::FilesomeInputList(el) => filesome_inputs.extend(el),
                        SoftwareMaterial::FilesomeOutputList(el) => filesome_outputs.extend(el),
                    }
                }
            }
        }
        let spec = spec.unwrap();

        Ok(Data::SoftwareUsecaseComputing(
            SoftwareUsecaseComputingData::Software(SoftwareData {
                spec,
                arguments,
                environments,
                filesome_inputs,
                filesome_outputs,
            }),
        ))
    }

    /// 解析得出用例包的数据
    ///
    /// # 参数
    ///
    /// * `data` - tar 包数据
    fn parse_usecase_data(mut data: Archive<Cursor<&[u8]>>) -> anyhow::Result<Data> {
        let mut spec: Option<UsecaseSpec> = None;
        let mut collected_outs = vec![];
        let mut template_file_infos = vec![];
        for entry in data.entries()? {
            let mut entry = entry?;

            let entry_path = entry.path()?.to_path_buf();
            let ancestors_count = entry_path.ancestors().count();
            if ancestors_count > PACKAGE_ANCESTORS_COUNT && entry.header().entry_type().is_file() {
                // 经过验证，祖先 +1 层级的叫`TEMPLATE_FILE_FOLDER_NAME`的文件一定是存放模板文件的文件夹
                if ancestors_count == PACKAGE_ANCESTORS_COUNT + 2
                    && entry_path
                        .ancestors()
                        .nth(1)
                        .map(|el| el.file_name().unwrap_or_default())
                        .unwrap_or_default()
                        .eq(TEMPLATE_FILE_FOLDER_NAME)
                {
                    let file_name = entry_path.file_name().unwrap().to_str().unwrap().to_string();
                    let mut content = String::new();
                    entry.read_to_string(&mut content)?;

                    let template_file_info = TemplateFileInfo {
                        descriptor: "".to_string(),
                        content,
                        file_name,
                    };
                    template_file_infos.push(template_file_info);
                } else {
                    let mut usecase_content = String::new();
                    entry.read_to_string(&mut usecase_content)?;
                    let usecase_contents = usecase_content.split("---").collect::<Vec<_>>();
                    for usecase_content in usecase_contents.iter() {
                        let usecase =
                            serde_json::from_value::<UsecaseMaterial>(serde_yaml::from_str::<
                                serde_json::Value,
                            >(
                                usecase_content
                            )?)?;
                        match usecase {
                            UsecaseMaterial::UsecaseSpec(el) => spec = Some(*el),
                            UsecaseMaterial::CollectedOutList(el) => collected_outs.extend(el),
                        }
                    }
                }
            }
        }
        let spec = spec.unwrap();

        template_file_infos.iter_mut().for_each(|el| {
            el.descriptor = spec
                .template_files
                .iter()
                .find(|el2| el2.path.eq(&el.file_name))
                .unwrap()
                .descriptor
                .to_owned()
        });

        Ok(Data::SoftwareUsecaseComputing(
            SoftwareUsecaseComputingData::Usecase(Box::new(UsecaseData {
                spec,
                collected_outs,
                template_file_infos,
            })),
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::model::vo::abilities::software_computing::common::SoftwareMaterial;

    // #[test]
    // fn test() {
    //     let tar_file =
    //         std::fs::read(r#"C:\Users\zooey\Codes\Work\SchemaTest\Repos\us1.tar"#).unwrap();
    //     let extract_package = Package::extract_package(uuid::Uuid::new_v4(), &tar_file).unwrap();
    //     println!("{extract_package:#?}");
    // }

    #[test]
    fn test2() {
        let x = r#"
        kind: SoftwareSpec
        spec:
          spack:
            argument_list:
              - "xx"
            name: computing
        "#;
        let material = serde_json::from_value::<SoftwareMaterial>(
            serde_yaml::from_str::<serde_json::Value>(x).unwrap(),
        )
        .unwrap();
        println!("{material:#?}");
    }
}
