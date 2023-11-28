use std::collections::HashMap;
use std::sync::Arc;

use domain_workflow::{
    model::entity::{node_instance::NodeInstanceKind, workflow_instance::NodeSpec},
    service::{UsecaseParseService, UsecaseSelectService},
};
use typed_builder::TypedBuilder;

#[derive(TypedBuilder)]
pub struct InnerUsecaseSelectService {
    usecases: HashMap<NodeInstanceKind, Arc<dyn UsecaseParseService>>,
}

#[async_trait::async_trait]
impl UsecaseSelectService for InnerUsecaseSelectService {
    async fn send_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        match self.usecases.get(&node_spec.kind.clone().into()) {
            Some(x) => x.handle_usecase(node_spec).await,
            None => {
                anyhow::bail!("No such sub task service called {:#?}", &node_spec.kind);
            }
        }
    }
}
