use alice_architecture::model::IAggregateRoot;
use num_derive::{FromPrimitive, ToPrimitive};
use serde::{Deserialize, Serialize};

impl IAggregateRoot for Cluster {}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
/// 集群信息
pub struct Cluster {
    /// id
    pub id: String,
    /// 名称
    pub name: String,
    /// 订阅的消息队列主题名称
    pub topic_name: String,
    /// 可用区 id
    pub available_zone_id: String,
    /// 集群技术
    pub cluster_tech: ClusterTech,
    pub enabled: bool,
}

#[derive(FromPrimitive, ToPrimitive, Clone, Serialize, Deserialize, Debug, Default)]
#[serde(tag = "type")]
pub enum ClusterTech {
    #[default]
    Slurm,
    Pbs,
}
