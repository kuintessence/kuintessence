//! 工单
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "work_order")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub title: String,
    pub r#type: i32,
    #[sea_orm(column_type = "Text")]
    pub description: String,
    pub assigned_user_id: Uuid,
    pub status: i32,
    pub start_time: DateTimeUtc,
    pub end_time: DateTimeUtc,
    pub created_user_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
