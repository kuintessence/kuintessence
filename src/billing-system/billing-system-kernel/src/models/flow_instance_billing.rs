use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl alice_architecture::model::IAggregateRoot for FlowInstanceBilling {}

/// 工作流实例
/// 工作流实例是工作流草稿提交之后解析形成的，其中记录的数据有恢复回工作流草稿的能力。
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct FlowInstanceBilling {
    pub id: Uuid,
    pub flow_instance_id: Uuid,
    pub cpu: i64,
    pub memory: i64,
    pub storage: i64,
    pub cpu_time: i64,
    pub wall_time: i64,
    pub total_price: Decimal,
    pub user_id: Uuid,
}
