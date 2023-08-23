//! 工作流草稿
use crate::system::prelude::*;
use kernel::models::prelude::WorkflowDraft;
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "flow_draft")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    pub description: String,
    #[sea_orm(column_type = "Text")]
    pub logo: Option<String>,
    pub spec: Json,
    pub user_id: Uuid,
    pub created_time: DateTimeUtc,
    pub last_modified_time: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "NodeDraftFileEntity")]
    NodeDraftFile,
}

impl Related<NodeDraftFileEntity> for Entity {
    fn to() -> RelationDef {
        Relation::NodeDraftFile.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}

impl TryInto<WorkflowDraft> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<WorkflowDraft, Self::Error> {
        Ok(WorkflowDraft {
            id: self.id,
            name: self.name,
            description: self.description,
            logo: self.logo,
            spec: serde_json::from_value(self.spec)?,
        })
    }
}
