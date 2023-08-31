use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// 命令行预览
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct CommandPreview {
    /// 软件安装参数
    pub software_facility: FacilityKind,
    /// 命令名称
    pub command_name: String,
    /// 参数排序、参数内容及占位符对应的输入插槽或模板描述符
    pub argument_formats_sorts: BTreeMap<usize, FormatFillPreview>,
    /// 环境变量键名、参数内容及占位符对应的输入插槽或模板描述符
    pub environment_formats: HashMap<String, FormatFillPreview>,
    /// 模板描述符及其键填充的输入插槽或模板描述符对应关系集合
    pub templates_kv_map: HashMap<String, HashMap<String, InDescriptor>>,
    /// 标准输入使用的输入插槽或模板描述符
    #[serde(default)]
    pub std_in: InDescriptor,
    /// 输入输出文件信息预览列表
    pub file_infos: Vec<FileInfoPreview>,
    /// 输出收集信息预览
    pub collect_previews: Vec<CollectPreview>,
}

/// 描述符种类
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type")]
pub enum InDescriptor {
    /// 模板
    Template { descriptor: String },
    /// 输入插槽
    InputSlot { descriptor: String },
    #[default]
    None,
}

/// 输入输出文件信息
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum FileInfoPreview {
    /// 由输入插槽或者模板文件提供的输入文件
    DynamicInput {
        /// 将由谁提供该实际输入
        from: InDescriptor,
    },
    /// 程序固定输入路径
    ConstInput {
        /// 将由谁提供该实际输入
        from: InDescriptor,
        /// 软件包中默认输入材料描述符
        input_material_descriptor: String,
        /// 默认输入文件所在路径
        path: String,
    },
    /// 由输入插槽提供的输出文件
    DynamicOutput {
        /// 重新指定输出文件名的输入插槽描述符
        from: InDescriptor,
        /// 软件包中默认输出材料描述符
        output_material_descriptor: String,
    },
    /// 程序固定输出路径
    ConstOutput {
        /// 软件包中输出材料描述符
        output_material_descriptor: String,
        /// 文件将要输出到的路径
        path: String,
    },
}

/// 格式填充预览
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct FormatFillPreview {
    /// 格式（包含占位符（若有））
    pub format: String,
    /// 每个占位符对应的输入插槽 descriptor
    pub placeholder_fill_map: HashMap<usize, InDescriptor>,
}

/// 从哪里收集
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct CollectPreview {
    /// 从哪收集
    pub from: PreviewCollectFrom,
    /// 收集规则
    pub rule: PreviewCollectRule,
    /// 收集到哪里
    pub to: PreviewCollectTo,
    /// 如果收集不到是否报错（true 时不报错）
    pub optional: bool,
}

/// 从哪里收集
#[derive(Clone, Serialize, Deserialize, Debug)]
pub enum PreviewCollectFrom {
    /// 收集文件输出
    FileOut {
        /// 软件包中输出材料描述符
        output_material_descriptor: String,
    },
    /// 收集标准输出
    Stdout,
    /// 收集标准错误输出
    Stderr,
}

/// 结果输出形式
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum PreviewCollectTo {
    /// 输出为文件
    File { path: String },
    /// 输出为文字
    Text,
}

/// 收集规则
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum PreviewCollectRule {
    /// 正则匹配
    Regex { pattern: String },
    /// 最后几行
    BottomLines { count: usize },
    /// 前几行
    TopLines { count: usize },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
/// 软件环境技术
pub enum FacilityKind {
    /// spack
    Spack {
        /// 软件名称
        name: String,
        /// 安装参数
        argument_list: Vec<String>,
    },
    /// singularity
    Singularity {
        /// 镜像名
        image: String,
        /// 镜像 tag
        tag: String,
    },
}

/// 资源使用
#[derive(Default, Deserialize, Serialize, Clone, Debug)]
pub struct TaskUsedResource {
    /// 处理器使用
    pub cpu: f64,
    /// 内存使用
    pub memory: f64,
    /// 存储使用
    pub storage: f64,
    /// 墙钟时间
    pub wall_time: std::time::Duration,
    /// 处理器时间
    pub cpu_time: std::time::Duration,
}

use crate::model::vo::abilities::software_computing::software::SoftwareSpec;
impl From<SoftwareSpec> for FacilityKind {
    fn from(l: SoftwareSpec) -> Self {
        match l {
            SoftwareSpec::Spack {
                name,
                argument_list,
            } => FacilityKind::Spack {
                name,
                argument_list,
            },
            SoftwareSpec::Singularity { image, tag } => FacilityKind::Singularity { image, tag },
        }
    }
}
