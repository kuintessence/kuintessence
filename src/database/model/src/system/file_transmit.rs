//! 文件传输
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "file_transmit")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub file_metadata_id: Uuid,
    pub from_storage_server_id: Uuid,
    pub to_storage_server_id: Uuid,
    pub from_node_instance_id: Uuid,
    pub to_node_instance_id: Uuid,
    pub from_slot: String,
    pub to_slot: String,
    pub r#type: i32,
    pub status: i32,
    /// 若是邮寄硬盘传输，记录运单号码
    pub tracking_number: Option<String>,
    pub start_time: DateTimeUtc,
    pub end_time: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
