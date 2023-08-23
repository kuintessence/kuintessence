use crate::models::prelude::{
    CollectTo as ModelCollectTo, CollectedOut, FileKind as ModelFileKind,
    FileOutOrigin as ModelFileOutOrigin, FilesomeInput, FilesomeOutput,
    InputSlot as ModelInputSlot, OutFile as ModelOutFile, OutputSlot as ModelOutputSlot,
    Requirements as ModelRequirements, TextRule as ModelTextRule,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 供前台使用的工作流草稿中节点草稿的数据
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeDraft {
    /// 节点草稿外部 id
    pub external_id: Uuid,
    /// 节点草稿名称
    pub name: String,
    /// 节点草稿描述
    pub description: String,
    /// 批量策略
    pub batch_strategies: Option<Vec<BatchStrategy>>,
    /// 输入插槽
    pub input_slots: Vec<NodeDraftInputSlot>,
    /// 输出插槽
    pub output_slots: Vec<NodeDraftOutputSlot>,
    /// 节点调度策略
    pub scheduling_strategy: SchedulingStrategy,
    /// 种类
    #[serde(flatten)]
    pub kind: NodeDraftKind,
}

/// 节点草稿种类
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum NodeDraftKind {
    /// 软件用例计算类型节点
    #[serde(rename_all = "camelCase")]
    SoftwareUsecaseComputing {
        /// 用例包 id
        usecase_version_id: Uuid,
        /// 软件包 id
        software_version_id: Uuid,
        /// 附加数据
        #[serde(default)]
        additional_datas: Option<Requirements>,
    },
}

/// 节点草稿输出插槽
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeDraftOutputSlot {
    /// 种类
    #[serde(flatten)]
    pub kind: NodeDraftOutputSlotKind,
    /// 描述符
    pub descriptor: String,
    /// 描述
    pub description: Option<String>,
    /// 是否可选
    #[serde(default)]
    pub optional: bool,
}

/// 节点草稿输出插槽类型
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum NodeDraftOutputSlotKind {
    /// 文件类型
    #[serde(rename_all = "camelCase")]
    File {
        /// 输出来源
        origin: FileOutOrigin,
        file_name: String,
        /// 是否是批量文件
        is_batch: bool,
    },
    /// 文本类型
    Text,
}

impl NodeDraftOutputSlot {
    /// 解析能力的输出插槽，形成节点输出插槽数据
    pub async fn parse_ablity_output_slot(
        l: &ModelOutputSlot,
        filesome_outputs: &[FilesomeOutput],
        collected_outs: &[CollectedOut],
    ) -> Self {
        match l {
            ModelOutputSlot::Text {
                descriptor,
                metadata,
                optional,
                ..
            } => Self {
                kind: NodeDraftOutputSlotKind::Text,
                descriptor: descriptor.to_owned(),
                description: metadata.extra.get("description").map(|el| el.to_string()),
                optional: optional.to_owned(),
            },
            ModelOutputSlot::File {
                descriptor,
                origin,
                optional,
                metadata,
                ..
            } => {
                let (file_name, is_batch) = match origin {
                    ModelFileOutOrigin::CollectedOut(collected_out_descriptor) => {
                        match &collected_outs
                            .iter()
                            .find(|el| el.descriptor.eq(collected_out_descriptor))
                            .unwrap()
                            .to
                        {
                            ModelCollectTo::File(out_file) => match out_file {
                                ModelOutFile::Normal(name) => (name.to_owned(), false),
                                ModelOutFile::Batched(name) => (name.to_owned(), true),
                            },
                            ModelCollectTo::Text => unreachable!(),
                        }
                    }
                    ModelFileOutOrigin::UsecaseOut(file_out_and_appointed_by) => {
                        match &filesome_outputs
                            .iter()
                            .find(|el| {
                                el.descriptor
                                    .eq(&file_out_and_appointed_by.file_out_material_descriptor)
                            })
                            .unwrap()
                            .file_kind
                        {
                            ModelFileKind::Normal(name) => (name.to_owned(), false),
                            ModelFileKind::Batched(name) => (name.to_owned(), true),
                        }
                    }
                };

                let origin = FileOutOrigin::from(origin.to_owned());

                Self {
                    kind: NodeDraftOutputSlotKind::File {
                        origin,
                        file_name,
                        is_batch,
                    },
                    descriptor: descriptor.to_owned(),
                    description: metadata.extra.get("description").map(|el| el.to_string()),
                    optional: optional.to_owned(),
                }
            }
        }
    }
}

/// 节点使用资源需求
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Requirements {
    /// 核心数
    pub cpu_cores: Option<usize>,
    /// 节点数
    pub node_count: Option<isize>,
    /// 最长等待时间（s）
    pub max_wall_time: Option<usize>,
    /// 最大核时消耗 (s)
    pub max_cpu_time: Option<usize>,
    /// 定时终止 (utc 0 时区 时间戳)
    pub stop_time: Option<usize>,
}

impl From<ModelRequirements> for Requirements {
    fn from(l: ModelRequirements) -> Self {
        Self {
            cpu_cores: l.cpu_cores,
            node_count: l.node_count,
            max_wall_time: l.max_wall_time,
            max_cpu_time: l.max_cpu_time,
            stop_time: l.stop_time,
        }
    }
}

/// 节点批量规格
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum BatchStrategy {
    /// 本身一批文件就是处理好的，naming pattern 可以提供也可以不提供
    #[serde(rename_all = "camelCase")]
    OriginalBatch {
        /// 输入插槽描述符
        input_slot_descriptor: String,
        /// 期望生成批量文件的命名 pattern，当是文字时不填写
        renaming_pattern: Option<String>,
    },
    /// 根据一个文件中的正则以不同填充产生的批量文件
    #[serde(rename_all = "camelCase")]
    MatchRegex {
        /// 输入插槽描述符
        input_slot_descriptor: String,
        /// 期望生成批量文件的命名 pattern，当是文字时不填写
        renaming_pattern: Option<String>,
        /// 文件中要应用填充规则的正则表达式
        regex_to_match: String,
        /// 填充次数
        fill_count: usize,
        /// 填充规则
        filler: Filler,
    },
}

/// 匹配到的内容填充器
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Filler {
    /// 自动化填充
    #[serde(rename_all = "camelCase")]
    AutoNumber { start: i32, step: i32 },
    /// 枚举类型的填充规则，从这些枚举中随机选用来填充
    #[serde(rename_all = "camelCase")]
    Enumeration {
        /// 用于枚举随机选用的字符串数组
        items: Vec<String>,
    },
}

/// 输入的文件
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FileInput {
    /// 文件元数据 id
    pub file_metadata_id: Uuid,
    /// 文件元数据名称
    pub file_metadata_name: String,
    /// 文件哈希值
    pub hash: String,
    /// 文件大小
    pub size: u64,
}

/// 节点输入插槽
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeDraftInputSlot {
    /// 种类
    #[serde(flatten)]
    pub kind: NodeDraftInputSlotKind,
    /// 是否可选
    #[serde(default)]
    pub optional: bool,
    /// 描述符
    pub descriptor: String,
    /// 描述
    pub description: Option<String>,
}

/// 节点输入插槽种类
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type")]
pub enum NodeDraftInputSlotKind {
    /// 文本输入
    #[serde(rename_all = "camelCase")]
    Text {
        /// 所有子任务文本 id 列表
        contents: Option<Vec<Uuid>>,
        /// 文本规则
        #[serde(default)]
        rule: TextInputSlotRule,
    },
    #[serde(rename_all = "camelCase")]
    /// 文件输入
    File {
        /// 子任务输入内容
        contents: Option<Vec<FileInput>>,
        /// 文件自动匹配使用的名字
        /// 使用 usecase 期望的文件名称
        expected_file_name: Option<String>,
        /// 是否是批量文件
        is_batch: bool,
    },
    #[default]
    Unknown,
}

impl NodeDraftInputSlot {
    /// 解析形成草稿节点输入插槽
    ///
    /// # 参数
    ///
    /// * `l` - 用例描述中的输入插槽
    /// * `filesome_inputs` - 软件描述中的默认文件输入材料
    pub async fn parse_ablity_input_slot(
        l: ModelInputSlot,
        filesome_inputs: Vec<FilesomeInput>,
    ) -> Self {
        match l {
            ModelInputSlot::Text {
                descriptor,
                text_rule,
                optional,
                metadata,
                ..
            } => Self {
                kind: NodeDraftInputSlotKind::Text {
                    contents: None,
                    rule: text_rule
                        .map(crate::dtos::node_draft::TextInputSlotRule::from)
                        .unwrap_or_default(),
                },
                optional,
                descriptor,
                description: metadata.extra.get("description").map(|el| el.to_string()),
            },
            // ability inputfile 转 nodedraft inputfile
            ModelInputSlot::File {
                descriptor,
                ref_materials,
                metadata,
                optional,
            } => {
                // 遍历用例的输入插槽
                let mut ref_iter = ref_materials.iter();
                let ref_file_descriptor = loop {
                    let ref_material = match ref_iter.next() {
                        Some(el) => el,
                        None => break None,
                    };
                    let ref_file_descriptor = ref_material.ref_file_descriptor().await;
                    if ref_file_descriptor.is_some() {
                        break Some(ref_file_descriptor.unwrap());
                    }
                };
                let (expected_file_name, is_batch) = if let Some(ref descriptor) =
                    ref_file_descriptor
                {
                    // 遍历计算材料中的输入文件
                    let mut filesome_input_iter = filesome_inputs.iter();
                    let filesome_input = loop {
                        // 找到对应文件的输入，这里一定会在遍历到最后之前找到
                        let filesome_input = filesome_input_iter.next().unwrap();
                        if filesome_input.descriptor.eq(descriptor) {
                            break filesome_input;
                        }
                    };
                    let expected_file_name = filesome_input.file_kind.expected_file_name().await;
                    let is_batch = filesome_input.file_kind.is_batch().await;
                    (expected_file_name, is_batch)
                } else {
                    (None, false)
                };

                Self {
                    kind: NodeDraftInputSlotKind::File {
                        contents: None,
                        expected_file_name,
                        is_batch,
                    },
                    optional,
                    descriptor,
                    description: metadata.extra.get("description").map(|el| el.to_string()),
                }
            }
        }
    }
}

/// 表单输入时的限制
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum TextInputSlotRule {
    /// 输入 Json
    Json,
    /// 数字
    Number,
    /// 匹配正则
    Regex { regex: String },
    /// 无规则
    #[default]
    AnyString,
}

impl From<ModelTextRule> for TextInputSlotRule {
    fn from(l: ModelTextRule) -> Self {
        match l {
            ModelTextRule::Json => Self::Json,
            ModelTextRule::Number => Self::Number,
            ModelTextRule::Regex(regex) => Self::Regex { regex },
        }
    }
}

/// 文件输出来源
#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum FileOutOrigin {
    /// 由输出搜集器收集的
    CollectedOut,
    /// 由用例输出的
    UsecaseOut,
}

impl From<ModelFileOutOrigin> for FileOutOrigin {
    fn from(l: ModelFileOutOrigin) -> Self {
        match l {
            ModelFileOutOrigin::CollectedOut(_) => Self::CollectedOut,
            ModelFileOutOrigin::UsecaseOut(_) => Self::UsecaseOut,
        }
    }
}

/// 调度策略
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum SchedulingStrategy {
    /// 手动指定一些集群，系统算法必须在这些里面选择
    Manual {
        /// 集群 id 列表
        clusters: Vec<String>,
    },
    /// 使用系统算法选择
    Auto,
    /// 手动指定一些集群，系统算法优先在这些里面选择
    Prefer {
        /// 集群 id 列表
        clusters: Vec<String>,
    },
}
