use crate::dtos::prelude::{
    NodeAbilityKind, NodeDraft, NodeDraftInputSlot, NodeDraftKind, NodeDraftOutputSlot,
    Requirements, SchedulingStrategy,
};
use uuid::Uuid;

/// 节点解析服务接口
#[async_trait::async_trait]
pub trait IParseNodeService {
    /// 通用的服务，解析各种类型节点
    ///
    /// 根据 ability_kind 决定把 json 解析成哪个结构体
    ///
    /// # 参数
    ///
    /// * `ability_kind`: 待解析的数据以及种类
    ///
    async fn parse_node(ability_kind: NodeAbilityKind) -> NodeDraft;
}
pub struct ParseNodeService {}
#[async_trait::async_trait]
impl IParseNodeService for ParseNodeService {
    /// 使用解析数据解析得出节点草稿数据并返回
    ///
    /// # 参数
    ///
    /// * `ability` - 节点解析数据
    async fn parse_node(ability: NodeAbilityKind) -> NodeDraft {
        match ability {
            NodeAbilityKind::SoftwareComputing(data) => {
                let name = data.usecase_spec.metadata.extra.get("name").unwrap().to_string();
                let description =
                    data.usecase_spec.metadata.extra.get("description").unwrap().to_string();
                let usecase_version_id = data.usecase_version_id;
                let software_version_id = data.software_version_id;
                let usecase_spec = data.usecase_spec;
                let filesome_inputs = data.filesome_inputs;
                let filesome_outputs = data.filesome_outputs;
                let collected_outs = data.collected_outs;
                let additional_datas = usecase_spec.requirements.map(Requirements::from);
                let external_id = Uuid::new_v4();
                let scheduling_strategy = SchedulingStrategy::Auto;
                let mut input_slots = vec![];
                let mut output_slots = vec![];
                for input in usecase_spec.input_slots.into_iter() {
                    input_slots.push(
                        NodeDraftInputSlot::parse_ablity_input_slot(
                            input,
                            filesome_inputs.to_owned(),
                        )
                        .await,
                    );
                }
                for output in usecase_spec.output_slots.into_iter() {
                    output_slots.push(
                        NodeDraftOutputSlot::parse_ablity_output_slot(
                            &output,
                            &filesome_outputs,
                            &collected_outs,
                        )
                        .await,
                    );
                }
                NodeDraft {
                    external_id,
                    name,
                    description,
                    batch_strategies: None,
                    input_slots,
                    output_slots,
                    scheduling_strategy,
                    kind: NodeDraftKind::SoftwareUsecaseComputing {
                        usecase_version_id,
                        software_version_id,
                        additional_datas,
                    },
                }
            }
        }
    }
}
