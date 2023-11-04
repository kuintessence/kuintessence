use alice_architecture::model::AggregateRoot;
use anyhow::anyhow;
use chrono::Utc;
use database_model::system::prelude::NodeInstanceModel;
use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::FromPrimitive;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::task::TaskUsedResource;
use crate::model::vo::NodeKind;

#[derive(Debug, Clone, Serialize, Deserialize, Default, AggregateRoot)]
/// # 节点实例
pub struct NodeInstance {
    /// 种类
    pub kind: NodeInstanceKind,
    /// id
    pub id: Uuid,
    /// 名称
    pub name: String,
    /// 是否是父节点
    pub is_parent: bool,
    /// 父节点 id
    pub batch_parent_id: Option<Uuid>,
    /// 属于的工作流实例 id
    pub flow_instance_id: Uuid,
    /// 节点实例状态
    pub status: NodeInstanceStatus,
    /// 队列 id
    pub queue_id: Option<Uuid>,
    /// 节点日志
    pub log: Option<String>,
    /// 计量
    pub resource_meter: Option<TaskUsedResource>,
}

#[derive(
    FromPrimitive, ToPrimitive, Clone, Serialize, Deserialize, Default, Debug, Hash, PartialEq, Eq,
)]
/// 节点实例种类
pub enum NodeInstanceKind {
    #[default]
    /// 软件计算能力
    SoftwareUsecaseComputing,
    /// 无操作
    NoAction,
    /// 脚本
    Script,
    Milestone,
}

#[derive(FromPrimitive, ToPrimitive, Clone, Serialize, Deserialize, Debug, Default, PartialEq)]
/// 节点实例状态
pub enum NodeInstanceStatus {
    #[default]
    /// # 已创建
    /// 作业实例已被创建，数据库此时储存了作业实例的各类信息
    Created,
    /// # 等待中
    /// 作业实例收到启动指令，正在等待相应能力子服务的处理
    Pending,
    /// # 进行中
    /// 作业实例已经被相应能力子服务确认正在处理中，此时通过状态日志可以查看细节信息
    Running,
    /// # 已结束
    /// 作业例的流程已全部完成且所有处理过的作业正常结束
    Finished,
    /// # 出错
    /// 作业实例处理过程出现错误，已停止
    Error,
    /// # 正在终止
    /// 作业实例在处理过程中收到终止指令，正在终止流程
    Stopping,
    /// # 已终止
    /// 作业实例的处理过程已经终止
    Stopped,
    /// # 待命中
    /// 等待前置作业完成，即可开始该作业的处理
    Standby,
    /// # 正在暂停
    /// 作业实例的处理过程正在暂停
    Pausing,
    /// # 已暂停
    /// 作业实例的处理过程已经暂停
    Paused,
    /// # 正在恢复
    /// 作业实例的处理过程正在恢复
    Recovering,
}

impl TryFrom<NodeInstanceModel> for NodeInstance {
    type Error = anyhow::Error;

    fn try_from(model: NodeInstanceModel) -> Result<Self, Self::Error> {
        let NodeInstanceModel {
            id,
            name,
            kind,
            is_parent,
            batch_parent_id,
            status,
            resource_meter,
            log,
            queue_id,
            flow_instance_id,
            created_time: _,
            last_modified_time: _,
        } = model;

        Ok(Self {
            kind: NodeInstanceKind::from_i32(kind).ok_or(anyhow!("Wrong node instance kind"))?,
            id,
            name,
            is_parent,
            batch_parent_id,
            flow_instance_id,
            status: NodeInstanceStatus::from_i32(status).ok_or(anyhow!("Wrong status type"))?,
            queue_id,
            log,
            resource_meter: resource_meter.map(serde_json::from_value).transpose()?,
        })
    }
}

impl TryFrom<NodeInstance> for NodeInstanceModel {
    type Error = anyhow::Error;

    fn try_from(value: NodeInstance) -> Result<Self, Self::Error> {
        let NodeInstance {
            kind,
            id,
            name,
            is_parent,
            batch_parent_id,
            flow_instance_id,
            status,
            queue_id,
            log,
            resource_meter,
        } = value;

        Ok(Self {
            id,
            name,
            kind: kind as i32,
            is_parent,
            batch_parent_id,
            status: status as i32,
            resource_meter: resource_meter.map(serde_json::to_value).transpose()?,
            log,
            queue_id,
            flow_instance_id,
            created_time: Utc::now().into(),
            last_modified_time: Utc::now().into(),
        })
    }
}

impl From<NodeKind> for NodeInstanceKind {
    fn from(l: NodeKind) -> Self {
        match l {
            NodeKind::SoftwareUsecaseComputing { .. } => Self::SoftwareUsecaseComputing,
            NodeKind::NoAction => Self::NoAction,
            NodeKind::Script { .. } => Self::Script,
            NodeKind::Milestone { .. } => Self::Milestone,
        }
    }
}
