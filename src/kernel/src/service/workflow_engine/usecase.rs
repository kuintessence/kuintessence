use crate::prelude::*;

#[async_trait]
/// 软件用例微服务
pub trait IUsecaseService {
    /// 处理用例
    /// 输入 节点信息
    /// 输出 Ok
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()>;

    /// 操作软件计算任务
    async fn operate_task(&self, operate: Operation) -> anyhow::Result<()>;
    fn get_service_type(&self) -> NodeInstanceKind;
    async fn get_cmd(&self, node_id: Uuid) -> anyhow::Result<Option<String>>;
}
