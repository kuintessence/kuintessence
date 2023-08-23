use crate::prelude::*;
use alice_architecture::model::IAggregateRoot;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

impl IAggregateRoot for WorkflowDraft {}

/// 工作流草稿
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct WorkflowDraft {
    /// id
    pub id: Uuid,
    /// 名称
    pub name: String,
    /// 描述
    pub description: String,
    /// 图标
    pub logo: Option<String>,
    /// 工作流草稿数据
    pub spec: WorkflowDraftSpec,
}

/// 工作流草稿 spec 数据
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowDraftSpec {
    /// 调度策略
    pub scheduling_strategy: SchedulingStrategy,
    /// 节点草稿列表
    pub node_drafts: Vec<NodeDraft>,
    /// 节点草稿关系列表
    pub node_relations: Vec<NodeRelation>,
}

/// 节点草稿
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeDraft {
    /// 种类
    #[serde(flatten)]
    pub kind: NodeKind,
    /// 外部 id
    pub external_id: Uuid,
    /// 名称
    pub name: String,
    /// 描述
    pub description: String,
    /// 批量策略
    pub batch_strategies: Option<Vec<BatchStrategy>>,
    /// 输入插槽
    pub input_slots: Vec<NodeInputSlot>,
    /// 输出插槽
    pub output_slots: Vec<NodeDraftOutputSlot>,
    /// 调度策略
    pub scheduling_strategy: SchedulingStrategy,
    /// 资源需求覆盖（若没有则采取用例包规定的）
    pub requirements: Option<Requirements>,
    /// 其他字段
    pub additional_datas: Option<HashMap<String, Value>>,
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
        /// 是否是批量文件
        is_batch: bool,
    },
    /// 文本类型
    Text,
}
