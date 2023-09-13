use std::sync::Arc;

use async_trait::async_trait;
use domain_content_repo::{
    model::vo::{
        node_ability_kind::{NodeAbilityKind, Packages},
        node_draft::{
            NodeDraft, NodeDraftInputSlot, NodeDraftKind, NodeDraftOutputSlot, Requirements,
            SchedulingStrategy,
        },
    },
    repository::PackageRepo,
    service::NodeDraftService,
};
use uuid::Uuid;

pub struct NodeDraftServiceImpl {
    package_repo: Arc<dyn PackageRepo>,
}

#[async_trait]
impl NodeDraftService for NodeDraftServiceImpl {
    async fn get_node_draft(
        &self,
        usecase_ver_id: Uuid,
        software_ver_id: Uuid,
    ) -> anyhow::Result<NodeDraft> {
        let software = self.package_repo.get_package(software_ver_id).await?;
        let usecase = self.package_repo.get_package(usecase_ver_id).await?;
        let node_ability =
            NodeAbilityKind::extract_packages(Packages::SoftwareComputing(usecase, software))?;
        Ok(Self::parse_node(node_ability).await)
    }
}

impl NodeDraftServiceImpl {
    #[inline]
    pub fn new(package_repo: Arc<dyn PackageRepo>) -> Self {
        Self { package_repo }
    }

    /// 使用解析数据解析得出节点草稿数据并返回
    ///
    /// * ability: 节点解析数据
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
                let additional_data = usecase_spec.requirements.map(Requirements::from);
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
                        additional_data,
                    },
                }
            }
        }
    }
}
