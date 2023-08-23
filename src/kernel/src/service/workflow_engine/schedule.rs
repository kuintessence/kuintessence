use crate::prelude::*;

pub enum ScheduleMode {
    WorkflowInstanceId(Uuid),
    NodeInstanceId(Uuid),
}

#[async_trait]
/// 工作流调度服务
pub trait IWorkflowScheduleService {
    /// 调度下一组节点
    /// 输入 工作流 Id、节点 Id
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn schedule_next_nodes(&self, mode: ScheduleMode) -> anyhow::Result<()>;

    /// 暂停工作流实例。
    /// 输入 工作流实例 id
    /// 过程 查询正在运行的节点 -> 要求相应的服务暂停
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn pause_workflow(&self, id: Uuid) -> anyhow::Result<()>;

    /// 继续工作流实例。
    /// 输入 工作流实例 id
    /// 过程 查询已暂停的节点 -> 要求相应的服务继续
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn continue_workflow(&self, id: Uuid) -> anyhow::Result<()>;

    /// 终止工作流实例。
    /// 输入 工作流实例 id
    /// 过程 查询正在运行的节点 -> 要求相应的服务终止
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn terminate_workflow(&self, id: Uuid) -> anyhow::Result<()>;
    /// 根据节点实例 id，分批节点实例，获取分批节点实例列表。
    /// 输入 节点实例 id
    /// 过程 读取节点实例 spec -> 解析批量信息 -> 形成分批节点实例 spec 列表
    /// 错误 数据库 调能力解析微服务
    async fn debatch(
        &self,
        node_relations: &[NodeRelation],
        node_spec: &NodeSpec,
    ) -> anyhow::Result<Vec<NodeSpec>>;
}
