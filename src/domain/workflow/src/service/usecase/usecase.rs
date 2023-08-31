use alice_architecture::utils::*;

use crate::model::{
    entity::{node_instance::NodeInstanceKind, workflow_instance::NodeSpec},
    vo::usecase::Operation,
};

#[async_trait]
/// 软件用例微服务
pub trait UsecaseService: Send + Sync {
    /// 处理用例
    /// 输入 节点信息
    /// 输出 Ok
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()>;

    /// 操作软件计算任务
    async fn operate_task(&self, operate: Operation) -> anyhow::Result<()>;

    fn get_service_type(&self) -> NodeInstanceKind;

    async fn get_cmd(&self, node_id: Uuid) -> anyhow::Result<Option<String>>;
}
