use derive_builder::Builder;
use kernel::prelude::*;
use std::{collections::HashMap, sync::Arc};

#[derive(Builder)]
pub struct InnerUsecaseSelectService {
    usecases: HashMap<NodeInstanceKind, Arc<dyn IUsecaseService + Send + Sync>>,
}

// impl InnerUsecaseSelectService {
//     pub fn new(
//         usecases: HashMap<NodeInstanceKind, Arc<dyn IUsecaseService + Send + Sync>>,
//     ) -> Self {
//         Self { usecases }
//     }
// }

#[async_trait::async_trait]
impl IUsecaseSelectService for InnerUsecaseSelectService {
    async fn send_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        match self.usecases.get(&node_spec.kind.clone().into()) {
            Some(x) => x.handle_usecase(node_spec).await,
            None => {
                anyhow::bail!("No such sub task service called {:#?}", &node_spec.kind);
            }
        }
    }
    async fn operate_task(&self, operation: OperateTask) -> anyhow::Result<()> {
        match self.usecases.get(&operation.kind.clone()) {
            Some(x) => x.operate_task(operation.operate).await,
            None => {
                anyhow::bail!("No such sub task service called {:#?}", &operation.kind);
            }
        }
    }
}
