use std::collections::HashMap;
use std::sync::Arc;

use alice_architecture::model::derive::AggregateRoot;
use alice_architecture::repository::ReadOnlyRepository;
use database_model::system::prelude::FlowDraftModel;
// WARN: 依赖了另外一个领域的实体
use domain_storage::model::entity::FileMeta;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    exception::{WorkflowException, WorkflowResult},
    model::vo::*,
};

/// 工作流草稿
#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
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
    /// 其他字段
    pub additional_data: Option<HashMap<String, Value>>,
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
    pub additional_data: Option<HashMap<String, Value>>,
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

impl TryFrom<FlowDraftModel> for WorkflowDraft {
    type Error = anyhow::Error;

    fn try_from(model: FlowDraftModel) -> Result<Self, Self::Error> {
        let FlowDraftModel {
            id,
            name,
            description,
            logo,
            spec,
            user_id: _,
            created_time: _,
            last_modified_time: _,
        } = model;

        Ok(Self {
            id,
            name,
            description,
            logo,
            spec: serde_json::from_value(spec)?,
        })
    }
}

impl WorkflowDraftSpec {
    /// 找到工作流草稿 Spec 中某 id 的节点
    ///
    /// # 参数
    ///
    /// * `id` - 节点草稿 id
    pub fn get_node(&self, id: Uuid) -> Option<&NodeDraft> {
        self.node_drafts.iter().find(|el| el.external_id.eq(&id))
    }

    /// 找到工作流草稿 Spec 中某 id 的节点
    ///
    /// # 参数
    ///
    /// * `id` - 节点草稿 id
    pub fn node(&self, id: Uuid) -> &NodeDraft {
        self.node_drafts.iter().find(|el| el.external_id.eq(&id)).unwrap()
    }

    /// 1. 节点依赖中提及的节点必须存在
    /// 2. 插槽依赖中提及的插槽必须存在
    /// 3. 文本输出只能对应文本输入，文件输出只能对应文件输入
    pub async fn validate_related_nodes(&self) -> WorkflowResult<Vec<String>> {
        let mut relied_input_slots = vec![];
        for node_relation in self.node_relations.iter() {
            let from_node_id = node_relation.from_id.to_owned();
            let to_node_id = node_relation.to_id.to_owned();

            let from_node = self.get_node(from_node_id).ok_or(WorkflowException::NoSuchNode {
                id: from_node_id.to_owned(),
            })?;
            let to_node = self.get_node(to_node_id).ok_or(WorkflowException::NoSuchNode {
                id: to_node_id.to_owned(),
            })?;

            for slot_relation in node_relation.slot_relations.iter() {
                let from_descriptor = &slot_relation.from_slot;
                let to_descriptor = &slot_relation.to_slot;
                relied_input_slots.push(to_descriptor.to_owned());
                let from_slot = from_node.get_output_slot(from_descriptor).ok_or(
                    WorkflowException::NoSuchOutputSlot {
                        node_id: from_node_id.to_owned(),
                        descriptor: from_descriptor.to_owned(),
                    },
                )?;
                let to_slot = to_node.get_input_slot(to_descriptor).ok_or(
                    WorkflowException::NoSuchOutputSlot {
                        node_id: to_node_id.to_owned(),
                        descriptor: to_descriptor.to_owned(),
                    },
                )?;
                if to_slot.inputs_count() != 0 {
                    return Err(WorkflowException::ReliedSlotContentsNotEmpty {
                        from_node_id,
                        from_descriptor: from_descriptor.to_owned(),
                        to_node_id,
                        to_descriptor: to_descriptor.to_owned(),
                    });
                }
                let mut flag = true;
                match from_slot.kind {
                    NodeDraftOutputSlotKind::File { .. } => {
                        if let NodeInputSlotKind::Text { .. } = to_slot.kind {
                            flag = false
                        }
                    }
                    NodeDraftOutputSlotKind::Text => {
                        if let NodeInputSlotKind::File { .. } = to_slot.kind {
                            flag = false
                        }
                    }
                };
                if !flag {
                    return Err(WorkflowException::MismatchedPairedSlot {
                        from_node_id,
                        from_descriptor: from_descriptor.to_owned(),
                        to_node_id,
                        to_descriptor: to_descriptor.to_owned(),
                    });
                }

                // slot_relations.push(SlotDraftRelation { from_slot, to_slot });
            }
            // r.push(NodeDraftRelation {
            //     from_node,
            //     to_node,
            //     slot_relations,
            // })
        }
        Ok(relied_input_slots)
    }

    /// 5. MatchRegex 类型批量输入必须等于 1
    /// 6. 调度策略 Manual 和 Prefer 至少选一个队列
    pub async fn validate_per_node(
        &self,
        relied_input_slots: Vec<String>,
        file_metadata_repository: Arc<dyn ReadOnlyRepository<FileMeta>>,
    ) -> WorkflowResult<()> {
        for node_draft in self.node_drafts.iter() {
            for input_slot in node_draft.input_slots.iter() {
                if !relied_input_slots.contains(&input_slot.descriptor)
                    && input_slot.inputs_count() < 1
                    && !input_slot.optional
                {
                    return Err(WorkflowException::NoReliedSlotContentsEmpty {
                        node_id: node_draft.external_id.to_owned(),
                        descriptor: input_slot.descriptor.to_owned(),
                    });
                } else if let NodeInputSlotKind::File { contents, .. } = &input_slot.kind {
                    for content in contents.as_ref().unwrap() {
                        file_metadata_repository
                            .get_by_id(content.file_metadata_id)
                            .await
                            .map_err(|_| WorkflowException::FileMetadataNotUploaded {
                                file_metadata_id: content.file_metadata_id.to_owned(),
                                node_id: node_draft.external_id.to_owned(),
                                descriptor: input_slot.descriptor.to_owned(),
                            })?;
                    }
                }
            }
            let mut flag = true;
            match &node_draft.scheduling_strategy {
                SchedulingStrategy::Manual { queues } => {
                    if queues.is_empty() {
                        flag = false
                    }
                }
                SchedulingStrategy::Prefer { queues } => {
                    if queues.is_empty() {
                        flag = false
                    }
                }
                SchedulingStrategy::Auto => {}
            }
            if !flag {
                return Err(WorkflowException::AtLeastOneQueue);
            }
            if node_draft.batch_strategies.is_none() {
                continue;
            }
            for batch_strategy in node_draft.batch_strategies.as_ref().unwrap().iter() {
                let input_slot = node_draft.input_slot(&batch_strategy.input_slot_descriptor);
                match &batch_strategy.kind {
                    BatchStrategyKind::MatchRegex { .. } => {
                        if input_slot.inputs_count() != 1 {
                            return Err(WorkflowException::NotSingleInputWithMatchRegex {
                                node_id: node_draft.external_id.to_owned(),
                                descriptor: input_slot.descriptor.to_owned(),
                            });
                        };
                    }
                    BatchStrategyKind::OriginalBatch => {
                        if !input_slot.inputs_count() >= 1 {
                            return Err(WorkflowException::OriginalBatchInputsLessThanOne {
                                node_id: node_draft.external_id.to_owned(),
                                descriptor: input_slot.descriptor.to_owned(),
                            });
                        }
                    }
                    BatchStrategyKind::FromBatchOutputs => {
                        match self.node_relations.iter().find(|el| {
                            el.slot_relations
                                .iter()
                                .any(|el2| el2.to_slot.eq(&input_slot.descriptor))
                        }) {
                            Some(node_relation) => {
                                let from_slot = &node_relation
                                    .slot_relations
                                    .iter()
                                    .find(|el| el.to_slot.eq(&input_slot.descriptor))
                                    .unwrap()
                                    .from_slot;
                                match &self.node(node_relation.from_id).batch_strategies {
                                    Some(batch_strategies) => {
                                        if batch_strategies.is_empty() {
                                            return Err(
                                                WorkflowException::ReliedNodeIsNotBatched {
                                                    from_node_id: node_relation.from_id.to_owned(),
                                                    node_id: node_draft.external_id.to_owned(),
                                                    descriptor: input_slot.descriptor.to_owned(),
                                                },
                                            );
                                        } else if !batch_strategies
                                            .iter()
                                            .any(|el| el.input_slot_descriptor.eq(from_slot))
                                        {
                                            return Err(
                                                WorkflowException::ReliedSlotIsNotBatched {
                                                    from_node_id: node_relation.from_id.to_owned(),
                                                    from_descriptor: from_slot.to_owned(),
                                                    node_id: node_draft.external_id.to_owned(),
                                                    descriptor: input_slot.descriptor.to_owned(),
                                                },
                                            );
                                        }
                                    }
                                    None => {
                                        return Err(WorkflowException::ReliedNodeIsNotBatched {
                                            from_node_id: node_relation.from_id.to_owned(),
                                            node_id: node_draft.external_id.to_owned(),
                                            descriptor: input_slot.descriptor.to_owned(),
                                        })
                                    }
                                }
                            }
                            None => {
                                return Err(WorkflowException::NoSuchBatchOutputs {
                                    node_id: node_draft.external_id.to_owned(),
                                    descriptor: input_slot.descriptor.to_owned(),
                                })
                            }
                        };
                    }
                };
            }
        }
        Ok(())
    }
}

impl NodeDraft {
    /// 根据 id 获取输入插槽
    ///
    /// # 参数
    ///
    /// * `descriptor` - 输入插槽描述符
    pub fn get_input_slot(&self, descriptor: &str) -> Option<&NodeInputSlot> {
        self.input_slots.iter().find(|el| el.descriptor.eq(descriptor))
    }

    /// 根据 id 获取输入插槽
    ///
    /// # 参数
    ///
    /// * `descriptor` - 输入插槽描述符
    pub fn input_slot(&self, descriptor: &str) -> &NodeInputSlot {
        self.input_slots.iter().find(|el| el.descriptor.eq(descriptor)).unwrap()
    }

    /// 根据 id 获取输出插槽
    ///
    /// # 参数
    ///
    /// * `descriptor` - 输出插槽描述符
    pub fn get_output_slot(&self, descriptor: &str) -> Option<&NodeDraftOutputSlot> {
        self.output_slots.iter().find(|el| el.descriptor.eq(descriptor))
    }

    /// 根据 id 获取输出插槽
    ///
    /// # 参数
    ///
    /// * `descriptor` - 输出插槽描述符
    pub fn output_slot(&self, descriptor: &str) -> &NodeDraftOutputSlot {
        self.output_slots.iter().find(|el| el.descriptor.eq(descriptor)).unwrap()
    }
}

impl NodeInputSlotKind {
    /// 判断输入插槽与一个输出插槽数据类型是否相同
    ///
    /// # 参数
    ///
    /// * `r` - 输出插槽
    pub fn is_same_kind(&self, r: &NodeDraftOutputSlotKind) -> anyhow::Result<bool> {
        Ok(match self {
            Self::Text { .. } => {
                matches!(r, NodeDraftOutputSlotKind::Text { .. })
            }
            Self::File { .. } => {
                matches!(r, NodeDraftOutputSlotKind::File { .. })
            }
            Self::Unknown => anyhow::bail!("Unknown input type!"),
        })
    }
}
