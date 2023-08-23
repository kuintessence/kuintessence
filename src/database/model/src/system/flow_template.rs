//! 工作流模板
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "flow_template")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub description: String,
    #[sea_orm(column_type = "Text")]
    pub logo: String,
    pub spec: Json,
    pub user_id: Uuid,
    pub created_time: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

pub use {
    ActiveModel as FlowTemplateActiveModel, Column as FlowTemplateColumn,
    Entity as FlowTemplateEntity, Model as FlowTemplateModel, PrimaryKey as FlowTemplatePrimaryKey,
    Relation as FlowTemplateRelation,
};
