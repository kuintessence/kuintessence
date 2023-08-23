use alice_architecture::model::IAggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl IAggregateRoot for NodeInstance {}

#[derive(Serialize, Deserialize)]
pub struct NodeInstance {
    pub id: Uuid,
    pub flow_id: Uuid,
    pub resource_meter: TaskUsedResource,
    pub cluster_id: Uuid,
}

#[derive(Serialize, Deserialize)]
pub struct TaskUsedResource {
    /// 核心数
    pub cpu: u64,
    /// 平均内存
    pub avg_memory: u64,
    /// 最大内存
    pub max_memory: u64,
    /// 存储空间
    pub storage: u64,
    /// 墙钟时间
    pub wall_time: u64,
    /// 核心时间
    pub cpu_time: u64,
    /// 节点数
    pub node: u64,
    /// 开始时间
    pub start_time: i64,
    /// 结束时间
    pub end_time: i64,
}
