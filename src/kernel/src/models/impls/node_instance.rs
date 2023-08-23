use crate::prelude::*;
use std::collections::HashMap;
use uuid::Uuid;

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
        }
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
            additional_datas: l.additional_datas,
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

impl From<NodeKind> for NodeInstanceKind {
    fn from(l: NodeKind) -> Self {
        match l {
            NodeKind::SoftwareUsecaseComputing { .. } => Self::SoftwareUsecaseComputing,
            NodeKind::NoAction => Self::NoAction,
            NodeKind::Script { .. } => Self::Script,
            NodeKind::Milestone { .. } => Self::Milestone,
        }
    }
}
