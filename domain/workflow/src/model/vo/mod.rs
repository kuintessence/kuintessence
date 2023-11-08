pub mod msg;
pub mod task_dto;

use domain_content_repo::model::vo::abilities::common::OutValidator;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

/// 调度策略
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum SchedulingStrategy {
    /// 手动指定一些队列，系统算法必须在这些里面选择
    Manual { queues: Vec<Uuid> },
    /// 使用系统算法选择
    #[default]
    Auto,
    /// 手动指定一些队列，系统算法优先在这些里面选择
    Prefer { queues: Vec<Uuid> },
}

/// 节点依赖关系
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeRelation {
    /// 出节点
    pub from_id: Uuid,
    /// 入节点
    pub to_id: Uuid,
    /// 节点间插槽关系
    pub slot_relations: Vec<SlotRelation>,
}

/// 插槽关系
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SlotRelation {
    /// 出插槽
    pub from_slot: String,
    /// 入插槽
    pub to_slot: String,
    /// 传输策略
    pub transfer_strategy: TransferStrategy,
}

/// 传输策略类型
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum TransferStrategy {
    /// 网络传输
    #[default]
    Network,
    /// 硬盘传输
    Disk,
}

/// 计算资源需求
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
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

/// 批量策略
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BatchStrategy {
    /// 输入插槽描述符
    pub input_slot_descriptor: String,
    /// 期望生成批量文件的命名 pattern，当是文字时不填写
    pub renaming_pattern: Option<String>,
    /// 批量策略种类
    #[serde(flatten)]
    pub kind: BatchStrategyKind,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type")]
/// 批量策略种类
pub enum BatchStrategyKind {
    /// 本身是一批文件，naming pattern 可以提供也可以不提供
    #[serde(rename_all = "camelCase")]
    #[default]
    OriginalBatch,
    /// 根据输入的正则匹配，由填充产生批量输入
    #[serde(rename_all = "camelCase")]
    MatchRegex {
        /// 输入中要应用填充规则的正则表达式
        regex_to_match: String,
        /// 填充次数
        fill_count: usize,
        /// 填充规则
        filler: Filler,
    },
    /// 来自其他节点的批量输出
    FromBatchOutputs,
}

/// 填充规则
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Filler {
    /// 数字自增自动填充
    #[serde(rename_all = "camelCase")]
    AutoNumber { start: i32, step: i32 },
    /// 枚举内随机填充
    #[serde(rename_all = "camelCase")]
    Enumeration {
        /// 从枚举字符串中随机选择，进行填充
        items: Vec<String>,
    },
}

impl Default for Filler {
    fn default() -> Self {
        Self::AutoNumber { start: 0, step: 1 }
    }
}

/// 一个文件输入
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FileInput {
    /// 文件对应的 id
    pub file_metadata_id: Uuid,
    /// 任务文件的名字
    pub file_metadata_name: String,
    /// 哈希值
    pub hash: String,
    /// 文件大小
    pub size: usize,
}

/// 该数据结构仅用于解析 OriginalBatch 类型的批量时使用
/// 一个 Input 对应一个子任务的输入
#[derive(Debug, Clone)]
pub enum Input {
    /// 文本类型 (Uuid)
    Text(Uuid),
    /// 文件类型
    File(FileInput),
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
/// 节点输入插槽
pub struct NodeInputSlot {
    /// 种类
    #[serde(flatten)]
    pub kind: NodeInputSlotKind,
    /// 是否可选
    #[serde(default)]
    pub optional: bool,
    /// 描述符
    pub descriptor: String,
    /// 描述
    pub description: Option<String>,
}

impl NodeInputSlot {
    pub fn is_empty_input(&self) -> bool {
        match &self.kind {
            NodeInputSlotKind::Text { contents, .. } => contents.is_none(),
            NodeInputSlotKind::File { contents, .. } => contents.is_none(),
            NodeInputSlotKind::Unknown => unreachable!(),
        }
    }
}

/// 节点输入插槽种类
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type")]
pub enum NodeInputSlotKind {
    /// 文本输入
    #[serde(rename_all = "camelCase")]
    Text {
        /// 所有子任务文本 id 列表
        contents: Option<Vec<Uuid>>,
        /// 文本规则
        #[serde(default)]
        rule: TextInputSlotRule,
    },
    /// 文件输入
    #[serde(rename_all = "camelCase")]
    File {
        /// 子任务内容
        contents: Option<Vec<FileInput>>,
        /// 文件自动匹配使用的名字
        /// 使用 usecase 期望的文件名称
        expected_file_name: Option<String>,
        /// 是否是批量文件（是否打包）
        is_batch: bool,
    },
    #[default]
    Unknown,
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

/// 文件输出来源
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub enum FileOutOrigin {
    /// 由输出收集器收集的
    CollectedOut,
    /// 由任务输出的
    #[default]
    UsecaseOut,
}

/// 节点草稿种类
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum NodeKind {
    /// 由任务输出的
    #[serde(rename_all = "camelCase")]
    SoftwareUsecaseComputing {
        #[serde(flatten)]
        data: SoftwareUsecaseComputing,
    },
    /// 无操作节点
    NoAction,
    /// 脚本节点
    Script {
        #[serde(flatten)]
        script_info: ScriptInfo,
    },
    Milestone {
        #[serde(flatten)]
        data: Milestone,
    },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScriptInfo {
    /// 脚本类型
    kind: ScriptKind,
    /// 输入插槽文件与路径对应关系
    input_path: HashMap<String, String>,
    /// 输出插槽文件与路径、验证规则对应关系
    output_path: HashMap<String, OutPathAndValidate>,
    /// 脚本来源
    origin: ScriptOriginKind,
}

/// 脚本输出路径和校验
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutPathAndValidate {
    /// 输出路径
    pub path: String,
    /// 校验规则
    pub validator: Option<OutValidator>,
}

/// 脚本来源
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ScriptOriginKind {
    /// 从 git 拉取
    Git {
        /// 链接
        url: String,
    },
    /// 从工作流编辑
    Edit {
        /// 内容
        content: String,
    },
}

/// 脚本类型
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ScriptKind {
    /// Python 脚本
    Python,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SoftwareUsecaseComputing {
    /// 用例包 id
    pub usecase_version_id: Uuid,
    /// 软件包 id
    pub software_version_id: Uuid,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Milestone {
    pub name: String,
    pub url: String,
    pub custom_message: String,
}

impl Default for NodeKind {
    fn default() -> Self {
        Self::SoftwareUsecaseComputing {
            data: SoftwareUsecaseComputing {
                usecase_version_id: Uuid::default(),
                software_version_id: Uuid::default(),
            },
        }
    }
}

impl NodeRelation {
    /// 改变节点关系中的旧 id 为新 id
    ///
    /// # 参数
    ///
    /// * `id_map` - 旧 id 与新 id 对照 map
    pub fn update_id(&mut self, id_map: &HashMap<Uuid, Uuid>) {
        for (old_id, new_id) in id_map.iter() {
            if old_id.eq(&self.from_id) {
                self.from_id = new_id.to_owned();
            }
            if old_id.eq(&self.to_id) {
                self.to_id = new_id.to_owned();
            }
        }
    }
}

impl Filler {
    /// 匹配输入提供文本的正则部分，返回填充后的文本列表
    ///
    /// # 参数
    ///
    /// * `content` - 匹配替换的文本内容
    /// * `regex_to_match` - 匹配的文本
    /// * `fill_count` - 替换生成文本次数
    pub fn fill_match_regex(
        &self,
        content: &str,
        regex_to_match: &str,
        fill_count: usize,
    ) -> Vec<String> {
        let mut texts = vec![content.to_owned(); fill_count];
        match self {
            Filler::AutoNumber { start, step } => {
                let mut current = start.to_owned();
                for text in texts.iter_mut() {
                    *text = text.replace(regex_to_match, &current.to_string());
                    current += *step;
                }
            }
            Filler::Enumeration { items } => {
                for text in texts.iter_mut() {
                    let n: usize = rand::thread_rng().gen_range(0..items.len());
                    *text = text.replace(regex_to_match, items.get(n).unwrap());
                }
            }
        };
        texts
    }
}

impl NodeInputSlot {
    /// 返回插槽上输入的个数
    pub fn inputs_count(&self) -> usize {
        match &self.kind {
            NodeInputSlotKind::Text { contents, .. } => contents.as_ref().unwrap().len(),
            NodeInputSlotKind::File { contents, .. } => contents.as_ref().unwrap().len(),
            NodeInputSlotKind::Unknown => unreachable!(),
        }
    }

    /// 返回插槽上所有的输入
    pub fn inputs(&self) -> Vec<Input> {
        match &self.kind {
            NodeInputSlotKind::Text { contents, .. } => {
                contents.as_ref().unwrap().iter().map(|el| Input::Text(el.to_owned())).collect()
            }
            NodeInputSlotKind::File { contents, .. } => {
                contents.as_ref().unwrap().iter().map(|el| Input::File(el.to_owned())).collect()
            }
            NodeInputSlotKind::Unknown => unreachable!(),
        }
    }

    /// 返回插槽上所有文件输入
    pub fn file_inputs(&self) -> anyhow::Result<&[FileInput]> {
        Ok(match &self.kind {
            NodeInputSlotKind::File { contents, .. } => contents.as_ref().unwrap(),
            _ => anyhow::bail!("InputSlot type is not file!"),
        })
    }
}
