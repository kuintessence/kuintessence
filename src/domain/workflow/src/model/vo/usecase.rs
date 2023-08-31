use uuid::Uuid;

use crate::model::entity::node_instance::NodeInstanceKind;
use crate::model::entity::task::TaskCommand;

/// 对任务的操作
pub struct OperateTask {
    /// 任务的种类
    pub kind: NodeInstanceKind,
    pub operate: Operation,
}

/// 操作行为
pub struct Operation {
    /// 任务 id
    pub task_id: Uuid,
    /// 操作类型
    pub command: TaskCommand,
}
