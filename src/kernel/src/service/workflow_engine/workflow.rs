use crate::prelude::*;

#[async_trait]
pub trait IWorkflowService {
    /// 根据工作流草稿 id，验证并解析工作流草稿，获取工作流实例及其节点实例列表并提交。
    /// 输入 工作流草稿 id
    /// 过程 读取工作流草稿 -> 验证工作流草稿 -> 解析工作流草稿 -> 存储工作流实例
    /// 输出 工作流实例 id
    /// 错误 数据库、验证失败、格式错误
    async fn submit_workflow(&self, id: Uuid) -> anyhow::Result<Uuid>;

    /// 开始工作流实例。
    /// 输入 工作流实例 id
    /// 过程 前往调度
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn start_workflow(&self, id: Uuid) -> anyhow::Result<()>;

    /// 暂停工作流实例。
    /// 输入 工作流实例 id
    /// 过程 前往调度
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn pause_workflow(&self, id: Uuid) -> anyhow::Result<()>;

    /// 继续工作流实例。
    /// 输入 工作流实例 id
    /// 过程 前往调度
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn continue_workflow(&self, id: Uuid) -> anyhow::Result<()>;

    /// 终止工作流实例。
    /// 输入 工作流实例 id
    /// 过程 前往调度
    /// 输出 成功状态
    /// 错误 数据库、调度失败
    async fn terminate_workflow(&self, id: Uuid) -> anyhow::Result<()>;

    /// 根据工作流 id 验证工作流草稿
    /// 输入 工作流草稿 id
    /// 过程 读取工作流草稿 -> 验证工作流草稿 -> 返回验证成功信息
    /// 输出 验证成功
    /// 错误 验证失败
    async fn validate(&self, id: Uuid) -> anyhow::Result<()>;

    /// 获取节点实例用户 id
    async fn get_node_user_id(&self, node_instance_id: Uuid) -> anyhow::Result<Uuid>;
}
