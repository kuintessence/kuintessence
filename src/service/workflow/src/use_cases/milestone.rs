use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{node_instance::NodeInstanceKind, workflow_instance::NodeSpec},
        vo::{usecase::Operation, NodeKind},
    },
    repository::NodeInstanceRepo,
    service::UsecaseService,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

pub struct MilestoneUsecaseServiceImpl {
    http_client: Arc<reqwest::Client>,
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
}

impl MilestoneUsecaseServiceImpl {
    pub fn new(
        http_client: Arc<reqwest::Client>,
        node_instance_repository: Arc<dyn NodeInstanceRepo>,
    ) -> Self {
        Self {
            http_client,
            node_instance_repository,
        }
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct MilestoneContent {
    pub flow_instance_id: String,
    pub name: String,
    pub message: String,
}

#[async_trait]
impl UsecaseService for MilestoneUsecaseServiceImpl {
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        let data = match &node_spec.kind {
            NodeKind::Milestone { data } => data,
            _ => anyhow::bail!("Unreachable node kind!"),
        };
        let url = url::Url::parse(&data.url)?;
        let node_instance =
            self.node_instance_repository.get_by_id(&node_spec.id.to_string()).await?;
        self.http_client
            .post(url)
            .json(&MilestoneContent {
                flow_instance_id: node_instance.flow_instance_id.to_string(),
                name: data.name.clone(),
                message: data.custom_message.clone(),
            })
            .send()
            .await?;
        Ok(())
    }

    async fn operate_task(&self, _operate: Operation) -> anyhow::Result<()> {
        Ok(())
    }

    fn get_service_type(&self) -> NodeInstanceKind {
        NodeInstanceKind::Milestone
    }

    async fn get_cmd(&self, _node_id: Uuid) -> anyhow::Result<Option<String>> {
        unimplemented!()
    }
}
