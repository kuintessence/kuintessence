//! 通知
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "notification")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub content: String,
    pub r#type: i32,
    pub priority: i32,
    pub is_read: bool,
    /// 关联事物的 id，由 type 决定事物类型
    pub related_item_id: Uuid,
    pub user_id: Uuid,
    pub is_deleted: bool,
    pub created_time: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
