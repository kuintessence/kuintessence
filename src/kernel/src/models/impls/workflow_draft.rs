use crate::prelude::*;
use alice_architecture::repository::IReadOnlyRepository;
use std::sync::Arc;

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

// /// 节点草稿依赖
// struct NodeDraftRelation<'a> {
//     /// 出节点
//     from_node: &'a NodeDraft,
//     /// 入节点
//     to_node: &'a NodeDraft,
//     /// 插槽依赖
//     slot_relations: Vec<SlotDraftRelation<'a>>,
// }

// /// 插槽依赖
// struct SlotDraftRelation<'a> {
//     /// 出插槽
//     from_slot: &'a NodeDraftOutputSlot,
//     /// 入插槽
//     to_slot: &'a NodeInputSlot,
// }

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
    pub async fn validate_related_nodes(&self) -> Result<Vec<String>, WorkflowDraftException> {
        let mut relied_input_slots = vec![];
        for node_relation in self.node_relations.iter() {
            let from_node_id = node_relation.from_id.to_owned();
            let to_node_id = node_relation.to_id.to_owned();

            let from_node =
                self.get_node(from_node_id).ok_or(WorkflowDraftException::NoSuchNode {
                    id: from_node_id.to_owned(),
                })?;
            let to_node = self.get_node(to_node_id).ok_or(WorkflowDraftException::NoSuchNode {
                id: to_node_id.to_owned(),
            })?;

            for slot_relation in node_relation.slot_relations.iter() {
                let from_descriptor = &slot_relation.from_slot;
                let to_descriptor = &slot_relation.to_slot;
                relied_input_slots.push(to_descriptor.to_owned());
                let from_slot = from_node.get_output_slot(from_descriptor).ok_or(
                    WorkflowDraftException::NoSuchOutputSlot {
                        node_id: from_node_id.to_owned(),
                        descriptor: from_descriptor.to_owned(),
                    },
                )?;
                let to_slot = to_node.get_input_slot(to_descriptor).ok_or(
                    WorkflowDraftException::NoSuchOutputSlot {
                        node_id: to_node_id.to_owned(),
                        descriptor: to_descriptor.to_owned(),
                    },
                )?;
                if to_slot.inputs_count() != 0 {
                    return Err(WorkflowDraftException::ReliedSlotContentsNotEmpty {
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
                    return Err(WorkflowDraftException::MismatchPairedSlot {
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
    /// 6. 调度策略 Manual 和 Prefer 至少选一个集群
    pub async fn validate_per_node(
        &self,
        relied_input_slots: Vec<String>,
        file_metadata_repository: Arc<dyn IReadOnlyRepository<FileMeta> + Send + Sync>,
    ) -> Result<(), WorkflowDraftException> {
        for node_draft in self.node_drafts.iter() {
            for input_slot in node_draft.input_slots.iter() {
                if !relied_input_slots.contains(&input_slot.descriptor)
                    && input_slot.inputs_count() < 1
                    && !input_slot.optional
                {
                    return Err(WorkflowDraftException::NoReliedSlotContentsEmpty {
                        node_id: node_draft.external_id.to_owned(),
                        descriptor: input_slot.descriptor.to_owned(),
                    });
                } else if let NodeInputSlotKind::File { contents, .. } = &input_slot.kind {
                    for content in contents.as_ref().unwrap() {
                        file_metadata_repository
                            .get_by_id(&content.file_metadata_id.to_string())
                            .await
                            .map_err(|_| WorkflowDraftException::FileMetadataNotUploaded {
                                file_metadata_id: content.file_metadata_id.to_owned(),
                                node_id: node_draft.external_id.to_owned(),
                                slot_descriptor: input_slot.descriptor.to_owned(),
                            })?;
                    }
                }
            }
            let mut flag = true;
            match &node_draft.scheduling_strategy {
                SchedulingStrategy::Manual { clusters } => {
                    if clusters.is_empty() {
                        flag = false
                    }
                }
                SchedulingStrategy::Prefer { clusters } => {
                    if clusters.is_empty() {
                        flag = false
                    }
                }
                SchedulingStrategy::Auto => {}
            }
            if !flag {
                return Err(WorkflowDraftException::AtLeastOneCluster);
            }
            if node_draft.batch_strategies.is_none() {
                continue;
            }
            for batch_strategy in node_draft.batch_strategies.as_ref().unwrap().iter() {
                let input_slot = node_draft.input_slot(&batch_strategy.input_slot_descriptor);
                match &batch_strategy.kind {
                    BatchStrategyKind::MatchRegex { .. } => {
                        if input_slot.inputs_count() != 1 {
                            return Err(WorkflowDraftException::NotSingleInputWithMatchRegex {
                                node_id: node_draft.external_id.to_owned(),
                                descriptor: input_slot.descriptor.to_owned(),
                            });
                        };
                    }
                    BatchStrategyKind::OriginalBatch => {
                        if !input_slot.inputs_count() >= 1 {
                            return Err(WorkflowDraftException::OriginalBatchInputsLessThanOne {
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
                                                WorkflowDraftException::ReliedNodeIsNotBatched {
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
                                                WorkflowDraftException::ReliedSlotIsNotBatched {
                                                    from_node_id: node_relation.from_id.to_owned(),
                                                    from_descriptor: from_slot.to_owned(),
                                                    node_id: node_draft.external_id.to_owned(),
                                                    descriptor: input_slot.descriptor.to_owned(),
                                                },
                                            );
                                        }
                                    }
                                    None => {
                                        return Err(
                                            WorkflowDraftException::ReliedNodeIsNotBatched {
                                                from_node_id: node_relation.from_id.to_owned(),
                                                node_id: node_draft.external_id.to_owned(),
                                                descriptor: input_slot.descriptor.to_owned(),
                                            },
                                        )
                                    }
                                }
                            }
                            None => {
                                return Err(WorkflowDraftException::NoSuchBatchOutputs {
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
