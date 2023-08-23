use crate::prelude::*;
use alice_architecture::model::IAggregateRoot;
use chrono::Utc;
use num_derive::{FromPrimitive, ToPrimitive};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, fmt::Debug};

impl IAggregateRoot for WorkflowInstance {}

/// 工作流实例
/// 工作流实例是工作流草稿提交之后解析形成的，其中记录的数据有恢复回工作流草稿的能力。
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct WorkflowInstance {
    /// id
    pub id: Uuid,
    /// 名称
    pub name: String,
    /// 描述
    pub description: String,
    /// 图标
    pub logo: Option<String>,
    /// 状态
    pub status: WorkflowInstanceStatus,
    /// 规格
    pub spec: WorkflowInstanceSpec,
    /// 最后修改时间
    pub last_modified_time: chrono::DateTime<Utc>,
    pub user_id: Uuid,
}

/// 工作流实例规格
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowInstanceSpec {
    /// 调度策略
    pub scheduling_strategy: SchedulingStrategy,
    /// 节点实例信息列表
    pub node_specs: Vec<NodeSpec>,
    /// 节点实例关系列表
    pub node_relations: Vec<NodeRelation>,
}

/// 根节点实例
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeSpec {
    /// 类型
    #[serde(flatten)]
    pub kind: NodeKind,
    /// id
    pub id: Uuid,
    /// 名称
    pub name: String,
    /// 描述
    pub description: String,
    /// 所有子节点的输入
    pub input_slots: Vec<NodeInputSlot>,
    /// 所有子节点的输出
    pub output_slots: Vec<NodeSpecOutputSlot>,
    /// 节点调度策略
    pub scheduling_strategy: SchedulingStrategy,
    /// 批量策略
    pub batch_strategies: Vec<BatchStrategy>,
    /// 资源需求覆盖（若没有则采取用例包规定的）
    pub requirements: Option<Requirements>,
    /// 其他字段
    pub additional_datas: Option<HashMap<String, Value>>,
}

/// 节点草稿输出插槽
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeSpecOutputSlot {
    /// 种类
    #[serde(flatten)]
    pub kind: NodeSpecOutputSlotKind,
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
pub enum NodeSpecOutputSlotKind {
    /// 文件类型
    #[serde(rename_all = "camelCase")]
    File {
        /// 输出来源
        origin: FileOutOrigin,
        /// 是否是批量文件
        is_batch: bool,
        /// 输出文件预分配 file_metadata uuid
        /// 如果 is_batch == true，则对于每个任务准备的输出 id 是 zip 压缩包的 id
        /// 这里的 Vec 的每个元素指的是每个子任务的输出 id！
        all_tasks_prepared_content_ids: Vec<Uuid>,
    },
    /// 文本类型
    Text {
        /// 文本输出不可能是多个
        /// 这里的 Vec 的每个元素指的是每个子任务的输出！
        all_tasks_prepared_text_keys: Vec<Uuid>,
    },
}

/// 工作流实例状态
#[derive(FromPrimitive, ToPrimitive, Clone, Serialize, Deserialize, Default, Debug)]
pub enum WorkflowInstanceStatus {
    /// # 已创建
    /// 工作流实例已被创建，数据库此时储存了工作流实例的各类信息
    Created,
    /// # 等待中
    /// 工作流实例已经启动，此时还未进行任何作业处理（调度、分解等）
    Pending,
    /// # 进行中
    /// 工作流实例已经启动，正在处理作业
    Running,
    /// # 已结束
    /// 工作流实例的流程已全部完成且所有处理过的作业正常结束
    Finished,
    /// # 出错
    /// 工作流实例处理过程出现错误，已停止处理
    Error,
    /// #正在终止
    /// 工作流实例在处理过程中收到终止指令，正在终止流程
    Stopping,
    /// # 已终止
    /// 工作流实例的处理过程已经终止
    Stopped,
    /// # 正在暂停
    /// 工作流实例的处理过程正在暂停
    Pausing,
    /// # 已暂停
    /// 工作流实例的处理过程已经暂停
    Paused,
    /// # 正在恢复
    /// 工作流实例的处理过程正在恢复
    Recovering,
    #[default]
    Unknown,
}
