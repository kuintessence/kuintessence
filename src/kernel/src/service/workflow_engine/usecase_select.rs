use crate::prelude::*;
use NodeInstanceKind as TaskKind;

/// 对任务的操作
pub struct Operation {
    /// 任务 id
    pub task_id: Uuid,
    /// 操作类型
    pub command: TaskCommand,
}

/// 操作种类
pub struct OperateTask {
    pub kind: TaskKind,
    pub operate: Operation,
}

#[async_trait]
/// 节点解析微服务选择微服务
pub trait IUsecaseSelectService {
    /// 接收节点类型、信息，返回解析状态
    /// 输入 节点类型、信息
    /// 输出 Ok 或解析失败信息
    async fn send_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()>;

    /// 操作用例产生的任务，返回成功与否
    ///
    /// # 参数
    ///
    /// * `operation` - 操作类型以及用例 id
    async fn operate_task(&self, operation: OperateTask) -> anyhow::Result<()>;
}
