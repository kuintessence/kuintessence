//! 存储服务器
use crate::system::prelude::*;
use kernel::models::prelude::{StorageServer, StorageType};
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "storage_server")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub name: String,
    /// 存储服务器配置选项
    pub options: Json,
    /// 存储容量
    pub capacity: String,
    pub storage_type: i32,
    pub available_zone_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "AvailableZoneEntity",
        from = "Column::AvailableZoneId",
        to = "AvailableZoneColumn::Id"
    )]
    AvailableZone,
}

impl Related<AvailableZoneEntity> for Entity {
    fn to() -> RelationDef {
        Relation::AvailableZone.def()
    }
}

impl Related<FileMetadataEntity> for Entity {
    // The final relation is Cake -> CakeFilling -> Filling
    fn to() -> RelationDef {
        FileStorageRelation::FileMetadata.def()
    }

    fn via() -> Option<RelationDef> {
        // The original relation is CakeFilling -> Cake,
        // after `rev` it becomes Cake -> CakeFilling
        Some(FileStorageRelation::StorageServer.def().rev())
    }
}

impl ActiveModelBehavior for ActiveModel {}

impl TryInto<StorageServer> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<StorageServer, Self::Error> {
        Ok(StorageServer {
            id: self.id,
            name: self.name,
            capacity: self.capacity.parse::<u64>()?,
            storage_type: match self.storage_type {
                0 => StorageType::ObjectStorage {
                    options: serde_json::from_value(self.options)?,
                },
                _ => unimplemented!(),
            },
            available_zone_id: self.available_zone_id,
        })
    }
}
