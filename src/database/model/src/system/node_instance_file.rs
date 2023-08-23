//! 工作流节点实例插槽文件对应关系
use crate::system::prelude::*;
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "node_instance_file")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub node_instance_id: Uuid,
    #[sea_orm(primary_key, auto_increment = false)]
    pub slot_descriptor: String,
    pub file_metadata_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "NodeInstanceEntity",
        from = "Column::NodeInstanceId",
        to = "NodeInstanceColumn::Id"
    )]
    NodeInstance,
    #[sea_orm(
        belongs_to = "FileMetadataEntity",
        from = "Column::FileMetadataId",
        to = "FileMetadataColumn::Id"
    )]
    FileMetadata,
}

impl Related<NodeInstanceEntity> for Entity {
    fn to() -> RelationDef {
        Relation::NodeInstance.def()
    }
}

impl Related<FileMetadataEntity> for Entity {
    fn to() -> RelationDef {
        Relation::FileMetadata.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
