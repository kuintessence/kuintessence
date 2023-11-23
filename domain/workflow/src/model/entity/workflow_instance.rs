use std::collections::HashMap;
use std::fmt::Debug;

use alice_architecture::model::AggregateRoot;
use anyhow::anyhow;
use chrono::DateTime;
use chrono::FixedOffset;
use database_model::flow_instance;
use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::FromPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::node_instance::NodeInstanceKind;
use super::workflow_draft::*;
use super::NodeInstance;
use crate::model::vo::*;

/// 工作流实例
/// 工作流实例是工作流草稿提交之后解析形成的，其中记录的数据有恢复回工作流草稿的能力。
#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
pub struct WorkflowInstance {
    /// id
    pub id: Uuid,
    /// 名称
    pub name: String,
    /// 描述
    pub description: Option<String>,
    /// 图标
    pub logo: Option<String>,
    /// 状态
    pub status: WorkflowInstanceStatus,
    /// 规格
    pub spec: WorkflowInstanceSpec,
    /// 最后修改时间
    pub last_modified_time: DateTime<FixedOffset>,
    /// user_id.
    /// Use to get user id via task id: Get node_instance_id then get workflow_instance, then get
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
    /// 其他字段
    pub additional_data: Option<HashMap<String, Value>>,
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
    pub additional_data: Option<HashMap<String, Value>>,
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
#[derive(FromPrimitive, ToPrimitive, Clone, Serialize, Deserialize, Debug, Default)]
pub enum WorkflowInstanceStatus {
    /// # 已创建
    /// 工作流实例已被创建，数据库此时储存了工作流实例的各类信息
    #[default]
    Created,
    /// # 等待中
    /// 工作流实例已经启动，此时还未进行任何作业处理（调度、分解等）
    Pending,
    /// # 进行中
    /// 工作流实例已经启动，正在处理作业
    Running,
    /// # 已结束
    /// 工作流实例的流程已全部完成且所有处理过的作业正常结束
    Completed,
    /// # 出错
    /// 工作流实例处理过程出现错误，已停止处理
    Failed,
    /// #正在终止
    /// 工作流实例在处理过程中收到终止指令，正在终止流程
    Terminating,
    /// # 已终止
    /// 工作流实例的处理过程已经终止
    Terminated,
    /// # 正在暂停
    /// 工作流实例的处理过程正在暂停
    Pausing,
    /// # 已暂停
    /// 工作流实例的处理过程已经暂停
    Paused,
    /// # 正在恢复
    /// 工作流实例的处理过程正在恢复
    Recovering,
}

impl TryFrom<flow_instance::Model> for WorkflowInstance {
    type Error = anyhow::Error;

    fn try_from(model: flow_instance::Model) -> Result<Self, Self::Error> {
        let flow_instance::Model {
            id,
            name,
            description,
            logo,
            status,
            spec,
            user_id,
            created_time: _,
            last_modified_time,
            project_id: _,
        } = model;

        Ok(Self {
            id,
            name,
            description,
            logo,
            status: WorkflowInstanceStatus::from_i32(status).ok_or(anyhow!("status is invalid"))?,
            spec: serde_json::from_value(spec)?,
            last_modified_time,
            user_id,
        })
    }
}

impl From<NodeDraft> for NodeSpec {
    fn from(l: NodeDraft) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: l.name,
            description: l.description,
            batch_strategies: match l.batch_strategies {
                Some(batch_strategies) => batch_strategies,
                None => vec![],
            },
            input_slots: l.input_slots,
            output_slots: l.output_slots.into_iter().map(NodeSpecOutputSlot::from).collect(),
            scheduling_strategy: l.scheduling_strategy,
            kind: l.kind,
            requirements: l.requirements,
            additional_data: l.additional_data,
        }
    }
}

impl From<NodeDraftOutputSlot> for NodeSpecOutputSlot {
    fn from(l: NodeDraftOutputSlot) -> NodeSpecOutputSlot {
        match l.kind {
            NodeDraftOutputSlotKind::File { origin, is_batch } => NodeSpecOutputSlot {
                descriptor: l.descriptor,
                description: l.description,
                optional: l.optional,
                kind: NodeSpecOutputSlotKind::File {
                    origin,
                    is_batch,
                    // 初始化时默认为普通节点，这里只有一个元素
                    all_tasks_prepared_content_ids: vec![Uuid::new_v4(); 1],
                },
            },
            NodeDraftOutputSlotKind::Text => NodeSpecOutputSlot {
                descriptor: l.descriptor,
                description: l.description,
                optional: l.optional,
                kind: NodeSpecOutputSlotKind::Text {
                    // 初始化时默认为普通节点，这里只有一个元素
                    all_tasks_prepared_text_keys: vec![Uuid::new_v4(); 1],
                },
            },
        }
    }
}

impl From<WorkflowDraft> for WorkflowInstance {
    fn from(l: WorkflowDraft) -> Self {
        Self {
            id: Uuid::new_v4(),
            name: l.name,
            description: l.description,
            logo: l.logo,
            status: WorkflowInstanceStatus::Created,
            spec: WorkflowInstanceSpec::from(l.spec),
            last_modified_time: chrono::DateTime::default(),
            ..Default::default()
        }
    }
}

impl From<WorkflowDraftSpec> for WorkflowInstanceSpec {
    fn from(l: WorkflowDraftSpec) -> Self {
        let old_node_ids =
            l.node_drafts.iter().map(|el| el.external_id.to_owned()).collect::<Vec<_>>();
        let node_specs = l.node_drafts.into_iter().map(NodeSpec::from).collect::<Vec<_>>();
        let new_node_ids = node_specs.iter().map(|el| el.id).collect::<Vec<_>>();
        let old_new_id_map = old_node_ids.into_iter().zip(new_node_ids).collect::<HashMap<_, _>>();
        let node_relations = l
            .node_relations
            .into_iter()
            .map(|mut el| {
                el.update_id(&old_new_id_map);
                el
            })
            .collect::<Vec<_>>();
        Self {
            scheduling_strategy: l.scheduling_strategy,
            node_specs,
            node_relations,
            additional_data: l.additional_data,
        }
    }
}

impl WorkflowInstance {
    /// Give a list of unschedule nodes, and return nodes to be schedule.
    pub fn find_entry_nodes(&self, unscheduled_nodes: &[Uuid], toggled_node_id: Uuid) -> Vec<Uuid> {
        let mut entry_nodes = vec![];
        let mut adjacenvy_map = HashMap::new();
        for node_id in unscheduled_nodes {
            adjacenvy_map.insert(*node_id, 0);
        }
        for (_, to_id) in self
            .spec
            .node_relations
            .iter()
            .filter(|el| el.from_id.ne(&toggled_node_id) && el.to_id.ne(&toggled_node_id))
            .map(|r| (r.from_id, r.to_id))
            .collect::<Vec<_>>()
        {
            adjacenvy_map.insert(to_id, 1 + adjacenvy_map.get(&to_id).unwrap_or(&0));
        }
        for (node_id, adjacency) in adjacenvy_map {
            if 0.eq(&adjacency) {
                entry_nodes.push(node_id)
            }
        }
        entry_nodes
    }

    /// Update node_instance prepared upload using file meta id,
    /// because in the case when file is uploading via node instance,
    /// but a flash upload occured, will cause different meta id between prepared and recorded.
    pub fn update_node_instance_prepared_file_ids(
        &mut self,
        old_id: Uuid,
        new_id: Uuid,
    ) -> anyhow::Result<()> {
        let entity_str = serde_json::to_string(&self)?;
        let entity_str = entity_str.replace(&old_id.to_string(), &new_id.to_string());
        *self = serde_json::from_str::<WorkflowInstance>(&entity_str)?;
        Ok(())
    }
    /// 得到某节点依赖节点与其关系以及插槽关系的列表
    ///
    /// # 参数
    ///
    /// * `node_id` - 被提供依赖的节点 id
    pub fn node_dependency_relations(&self, node_id: Uuid) -> Vec<NodeRelation> {
        self.spec
            .node_relations
            .iter()
            .filter(|el| el.to_id.eq(&node_id))
            .cloned()
            .collect::<Vec<_>>()
    }

    /// 填充被提供依赖的节点的所有输入插槽产生任务节点，如果是批量节点，提供使用批量节点的子节点输出次序
    ///
    /// # 参数
    ///
    /// * `node` - 被提供依赖的节点
    /// * `nth` - 如果是批量依赖，nth 表示依赖节点上插槽的输出列表上的第几个与输入对应
    pub fn produce_node_spec_by_complete_node_inputs(
        &self,
        node: &NodeSpec,
        nth: Option<usize>,
    ) -> anyhow::Result<NodeSpec> {
        let nth = nth.unwrap_or(0);
        let mut node = node.clone();
        let node_relations = self.node_dependency_relations(node.id);

        for input_slot in node.input_slots.iter_mut() {
            for node_relation in node_relations.iter() {
                for slot_relation in node_relation.slot_relations.iter() {
                    if slot_relation.to_slot.eq(&input_slot.descriptor) {
                        let out_slot = self
                            .spec
                            .node(node_relation.from_id)
                            .output_slot(&slot_relation.from_slot);

                        match &mut input_slot.kind {
                            NodeInputSlotKind::Text { contents, .. } => {
                                let inputs = out_slot.all_tasks_text_outputs()?;
                                let nth_input = inputs.get(nth).ok_or(anyhow::anyhow!(
                                    "input_slot doesn't have {nth}th output!"
                                ))?;
                                *contents = Some(vec![nth_input.to_owned(); 1]);
                            }
                            NodeInputSlotKind::File { contents, .. } => {
                                let inputs = out_slot.all_tasks_file_outputs()?;
                                let nth_input = inputs.get(nth).ok_or(anyhow::anyhow!(
                                    "input_slot doesn't have {nth}th output!"
                                ))?;
                                *contents = Some(vec![
                                    FileInput {
                                        file_metadata_id: nth_input.to_owned(),
                                        ..Default::default()
                                    };
                                    1
                                ]);
                            }
                            NodeInputSlotKind::Unknown => {
                                anyhow::bail!("Unknown input slot kind!")
                            }
                        };
                    }
                }
            }
        }
        Ok(node)
    }
}

impl NodeSpecOutputSlot {
    /// 获取所有任务在这个输出插槽上的文件输出的 Id
    pub fn all_tasks_file_outputs(&self) -> anyhow::Result<&[Uuid]> {
        Ok(match &self.kind {
            NodeSpecOutputSlotKind::File {
                all_tasks_prepared_content_ids,
                ..
            } => all_tasks_prepared_content_ids,
            _ => anyhow::bail!("OutputSlot {}'s kind is not file", self.descriptor),
        })
    }

    /// 获取所有任务在这个输出插槽上的文本输出的 Id
    pub fn all_tasks_text_outputs(&self) -> anyhow::Result<&[Uuid]> {
        Ok(match &self.kind {
            NodeSpecOutputSlotKind::Text {
                all_tasks_prepared_text_keys,
                ..
            } => all_tasks_prepared_text_keys,
            _ => anyhow::bail!("OutputSlot {}'s kind is not text", self.descriptor),
        })
    }
}

impl NodeSpec {
    /// 由任务输入数据更新输入插槽列表
    /// # 参数
    ///
    /// * `inputs` - 节点输入插槽与输入对应关系
    pub fn update_with_inputs(&mut self, inputs: &[(&str, Input)]) -> anyhow::Result<()> {
        for (slot_descriptor, input) in inputs.iter() {
            for input_slot in self.input_slots.iter_mut() {
                if input_slot.descriptor.eq(slot_descriptor) {
                    match &mut input_slot.kind {
                        NodeInputSlotKind::Text { contents, .. } => match input {
                            Input::Text(id) => *contents = Some(vec![id.to_owned(); 1]),
                            Input::File(..) => anyhow::bail!(
                                "Mismatched input type! node_input_slot_{}: text; input: file",
                                input_slot.descriptor
                            ),
                        },
                        NodeInputSlotKind::File { contents, .. } => match input {
                            Input::File(file_input) => {
                                *contents = Some(vec![file_input.to_owned(); 1]);
                            }
                            Input::Text(..) => anyhow::bail!(
                                "Mismatched input type! node_input_slot_{}: file; input: text",
                                input_slot.descriptor
                            ),
                        },
                        NodeInputSlotKind::Unknown => anyhow::bail!("Unknown input type!"),
                    };
                }
            }
        }

        Ok(())
    }

    /// 更新输出插槽列表
    pub fn update_output_slots(&mut self) {
        self.output_slots.iter_mut().for_each(|el| match &mut el.kind {
            NodeSpecOutputSlotKind::File {
                all_tasks_prepared_content_ids,
                ..
            } => *all_tasks_prepared_content_ids = vec![Uuid::new_v4(); 1],
            NodeSpecOutputSlotKind::Text {
                all_tasks_prepared_text_keys,
                ..
            } => *all_tasks_prepared_text_keys = vec![Uuid::new_v4(); 1],
        });
    }

    /// 根据 id 从节点中获取插槽
    pub fn input_slot(&self, descriptor: &str) -> &NodeInputSlot {
        self.input_slots.iter().find(|el| el.descriptor.eq(descriptor)).unwrap()
    }

    /// 根据 id 从节点中获取可变插槽
    pub fn mut_input_slot(&mut self, descriptor: &str) -> &mut NodeInputSlot {
        self.input_slots.iter_mut().find(|el| el.descriptor.eq(descriptor)).unwrap()
    }

    pub fn output_slot(&self, descriptor: &str) -> &NodeSpecOutputSlot {
        self.output_slots.iter().find(|el| el.descriptor.eq(descriptor)).unwrap()
    }

    /// 解析返回节点的批量子节点规格信息
    /// 每个批量子节点差别就在于输入插槽和输入插槽
    ///
    /// # 参数
    ///
    /// * `tasks_inputs_vec` - 所有任务中插槽的所有可能性输入
    ///     *  `Uuid` - 任务的 id
    ///     *  `String` - 子结点中插槽 id
    ///     *  `Input` - 插槽对应的输入
    pub fn parse_sub_nodes(
        &self,
        tasks_inputs: &[(Uuid, &Vec<(&str, Input)>)],
    ) -> anyhow::Result<Vec<NodeSpec>> {
        let mut sub_nodes = vec![self.clone(); tasks_inputs.len()];

        for ((id, inputs), sub_node) in tasks_inputs.iter().zip(sub_nodes.iter_mut()) {
            sub_node.id = *id;
            sub_node.update_with_inputs(inputs)?;
            sub_node.update_output_slots();
        }

        Ok(sub_nodes)
    }

    /// 得到节点上所有输入插槽的所有文本 id（可能为空）
    pub fn text_keys(&self) -> Vec<Uuid> {
        let mut result = vec![];
        for input_slot in self.input_slots.iter() {
            if let NodeInputSlotKind::Text { contents, .. } = &input_slot.kind {
                result.extend_from_slice(contents.as_ref().unwrap());
            }
        }
        result
    }
}

impl WorkflowInstanceSpec {
    /// 根据 id 取得节点
    ///
    /// # 参数：
    ///
    /// * `id` - 节点 id
    pub fn node(&self, id: Uuid) -> &NodeSpec {
        self.node_specs.iter().find(|el| el.id.eq(&id)).unwrap()
    }

    /// 根据 id 取得可变节点
    ///
    /// # 参数：
    ///
    /// * `id` - 节点 id
    pub fn node_mut(&mut self, id: Uuid) -> &mut NodeSpec {
        self.node_specs.iter_mut().find(|el| el.id.eq(&id)).unwrap()
    }
}

impl WorkflowInstance {
    /// 计算节点实例的子节点个数
    ///
    /// * 参数
    ///
    /// `node_id` - 节点实例 id
    fn sub_node_count(&self, node_id: Uuid) -> usize {
        // 获得节点实例信息
        let node_spec = self.spec.node(node_id);

        let sub_node_count =
            node_spec.batch_strategies.iter().fold(1_usize, |acc, batch_strategy| {
                let input_slot_descriptor = &batch_strategy.input_slot_descriptor;
                match batch_strategy.kind {
                    // OriginalBatch，取输入插槽的输入数量
                    BatchStrategyKind::OriginalBatch => {
                        let count = node_spec.input_slot(input_slot_descriptor).inputs_count();
                        acc * count
                    }

                    // MatchRegex，取填充数量
                    BatchStrategyKind::MatchRegex { fill_count, .. } => acc * fill_count,
                    // FromBatchOutputs，取其依赖的节点的子任务个数
                    BatchStrategyKind::FromBatchOutputs => {
                        let node_relied_nodes = self.node_dependency_relations(node_spec.id);
                        let from_node_id = node_relied_nodes
                            .iter()
                            .find(|el| {
                                el.slot_relations
                                    .iter()
                                    .any(|el2| el2.to_slot.eq(input_slot_descriptor))
                            })
                            .unwrap()
                            .from_id;
                        let count = self.sub_node_count(from_node_id);
                        acc * count
                    }
                }
            });
        sub_node_count
    }

    /// 解析工作流实例得到节点实例列表
    /// 工作流实例 spec 中的节点（根节点）分两种：
    /// 1. 普通节点
    /// 2. 批量父节点
    /// 批量父节点的解析逻辑在工作流调度时进行
    pub async fn parse_node_instances(&self) -> anyhow::Result<Vec<NodeInstance>> {
        let node_instances = self
            .spec
            .node_specs
            .iter()
            .map(|node_spec| {
                let mut node_instances = vec![];
                let root_instance = NodeInstance {
                    kind: NodeInstanceKind::from(node_spec.kind.to_owned()),
                    id: node_spec.id.to_owned(),
                    name: node_spec.name.to_owned(),
                    is_parent: !node_spec.batch_strategies.is_empty(),
                    flow_instance_id: self.id.to_owned(),
                    ..Default::default()
                };

                node_instances.push(root_instance.to_owned());
                if root_instance.is_parent {
                    let count = self.sub_node_count(node_spec.id);
                    for i in 0..count {
                        node_instances.push(NodeInstance {
                            id: Uuid::new_v4(),
                            name: format!("{}_sub_task_{}", node_spec.name, i),
                            is_parent: false,
                            batch_parent_id: Some(root_instance.id.to_owned()),
                            ..root_instance.to_owned()
                        })
                    }
                }
                node_instances
            })
            .collect::<Vec<_>>();

        Ok(node_instances.into_iter().flatten().collect::<Vec<_>>())
    }
}
