use crate::model::vo::abilities::{
    common::{Metadata, OutValidator},
    software_computing::common::Requirements,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 用例规格
pub struct UsecaseSpec {
    /// 用例对应的可执行文件
    pub command_file: String,
    #[serde(default)]
    /// 是否合并标准输出和错误输出
    pub merge_stdout_and_stderr: bool,
    /// 对于用户直观的输入插槽
    pub input_slots: Vec<InputSlot>,
    /// 描述模板文件文件夹里面的模板文件
    #[serde(default)]
    pub template_files: Vec<TemplateFile>,
    /// 对于用户直观的输出插槽
    pub output_slots: Vec<OutputSlot>,
    #[serde(default)]
    /// 没有值的参数，String 代表软件中参数的描述符
    pub flag_arguments: HashMap<String, usize>,
    #[serde(default)]
    /// 值为空字符串的环境变量，String 代表软件中环境变量的描述符
    pub flag_environments: Vec<String>,
    /// 输出验证器
    pub std_out_validator: Option<OutValidator>,
    /// 输入验证器
    pub std_err_validator: Option<OutValidator>,
    /// 需要的物理资源
    pub requirements: Option<Requirements>,
    /// 提供描述的元数据
    #[serde(default)]
    pub metadata: Metadata,
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 输出插槽
pub enum OutputSlot {
    /// 文本输出
    /// 由于文本输出只有一个源头，就是 collected_out，所以填写一个在 usecase 中定义的其 id
    #[serde(rename_all = "camelCase")]
    Text {
        /// 输出插槽描述符
        descriptor: String,
        /// 输出来源的输出收集器描述符
        collected_out_descriptor: String,
        #[serde(default)]
        metadata: Metadata,
        #[serde(default)]
        /// 是否可选
        optional: bool,
        /// 验证使用的验证器
        validator: Option<OutValidator>,
    },
    File {
        /// 输出插槽描述符
        descriptor: String,
        /// 输出来源
        origin: FileOutOrigin,
        #[serde(default)]
        /// 是否可选
        optional: bool,
        #[serde(default)]
        metadata: Metadata,
        /// 验证使用的验证器
        validator: Option<OutValidator>,
    },
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 文件输出插槽的来源可能是用例本身输出的也可以是收集输出的
pub enum FileOutOrigin {
    /// 由输出搜集器收集的（填写输出收集器描述符）
    #[serde(rename_all = "camelCase")]
    CollectedOut(String),
    /// 由用例输出的（填写软件描述包中的 FilesomeOutput 描述符）
    #[serde(rename_all = "camelCase")]
    UsecaseOut(FileOutAndAppointedBy),
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 选择文件输出，并且提供覆盖输出文件名的种类
pub struct FileOutAndAppointedBy {
    /// 软件中定义的输出文件材料描述符
    pub file_out_material_descriptor: String,
    /// 输出文件名称的来源
    #[serde(default)]
    pub kind: AppointedBy,
}

/// 由什么指定的输出
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone, Default)]
#[serde(deny_unknown_fields)]
pub enum AppointedBy {
    /// 由默认输出路径指定
    #[default]
    Material,
    /// 由输入指定
    #[serde(rename_all = "camelCase")]
    InputSlot {
        /// 指定输出文件名字的 text 类型的输入插槽的描述符
        text_input_descriptor: String,
    },
}

/// 输入插槽枚举
#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub enum InputSlot {
    /// 文本输入插槽
    #[serde(rename_all = "camelCase")]
    Text {
        ///描述符
        descriptor: String,
        /// 文本规则
        text_rule: Option<TextRule>,
        ///对应的计算材料
        ref_materials: Vec<TextRef>,
        /// 提供描述的元数据
        #[serde(default)]
        metadata: Metadata,
        /// 是否可选
        #[serde(default)]
        optional: bool,
    },
    /// 文件输入插槽
    #[serde(rename_all = "camelCase")]
    File {
        ///描述符
        descriptor: String,
        ///对应的计算材料
        ref_materials: Vec<FileRef>,
        ///提供描述的元数据
        #[serde(default)]
        metadata: Metadata,
        /// 是否可选
        #[serde(default)]
        optional: bool,
    },
}

impl InputSlot {
    pub fn descriptor(&self) -> &str {
        match self {
            InputSlot::Text { descriptor, .. } => descriptor,
            InputSlot::File { descriptor, .. } => descriptor,
        }
    }
    pub fn optional(&self) -> &bool {
        match self {
            InputSlot::Text { optional, .. } => optional,
            InputSlot::File { optional, .. } => optional,
        }
    }
    pub fn metadata(&self) -> &Metadata {
        match self {
            InputSlot::Text { metadata, .. } => metadata,
            InputSlot::File { metadata, .. } => metadata,
        }
    }
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 使用的模板文件计算材料
pub struct TemplateFile {
    /// 描述符
    pub descriptor: String,
    /// software material 中模板文件描述模板的存放位置
    pub path: String,
    /// 模板的内容被挂载
    #[serde(default)]
    pub as_content: Vec<TextRef>,
    /// 模板的文件名被挂载
    #[serde(default)]
    pub as_file_name: Vec<FileRef>,
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 文本规则
pub enum TextRule {
    /// Json
    Json,
    /// 数字
    Number,
    /// 正则表达式
    Regex(String),
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 文本挂载到的软件材料
pub enum TextRef {
    #[serde(rename_all = "camelCase")]
    /// 挂载到参数
    ArgRef {
        /// 挂载到的参数的描述符
        descriptor: String,
        /// 占位符位次
        #[serde(default)]
        placeholder_nth: usize,
        /// 参数次序
        sort: usize,
    },
    #[serde(rename_all = "camelCase")]
    /// 挂载到环境变量
    EnvRef {
        /// 挂载到的环境变量的描述符
        descriptor: String,
        #[serde(default)]
        /// 占位符位次
        placeholder_nth: usize,
    },
    /// 挂载到标准输入
    StdIn,
    #[serde(rename_all = "camelCase")]
    /// 挂载到模板文件中
    TemplateRef {
        /// 模板 descriptor
        descriptor: String,
        /// 用于填充模板中的哪些键
        ref_keys: Vec<String>,
    },
}

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 文件挂载到的软件材料
pub enum FileRef {
    #[serde(rename_all = "camelCase")]
    /// 挂载到参数
    ArgRef {
        /// 参数描述符
        descriptor: String,
        /// 占位符位次
        #[serde(default)]
        placeholder_nth: usize,
        ///参数次序
        #[serde(default)]
        sort: usize,
    },
    #[serde(rename_all = "camelCase")]
    /// 挂载到环境变量
    EnvRef {
        /// 环境变量描述符
        descriptor: String,
        #[serde(default)]
        /// 占位符位次
        placeholder_nth: usize,
    },
    #[serde(rename_all = "camelCase")]
    /// 挂载到标准输入
    StdIn,
    /// 挂载到默认文件输入
    FileInputRef(String),
    #[serde(rename_all = "camelCase")]
    /// 使用文件名挂载到模板文件中
    TemplateRef {
        /// 模板 descriptor
        descriptor: String,
        ///用于填充模板中的哪些键
        ref_keys: Vec<String>,
    },
}

impl FileRef {
    pub async fn ref_file_descriptor(&self) -> Option<String> {
        match self.to_owned() {
            FileRef::ArgRef { .. } => None,
            FileRef::EnvRef { .. } => None,
            FileRef::StdIn => None,
            FileRef::FileInputRef(descriptor) => Some(descriptor),
            FileRef::TemplateRef { .. } => None,
        }
    }
}
