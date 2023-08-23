//! 文件副本
//! 由文件元数据与存储服务器共同标识
use crate::system::prelude::*;
use chrono::Utc;
use kernel::models::prelude::FileStorage;
use sea_orm::{entity::prelude::*, Set};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "file_storage")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub storage_server_id: Uuid,
    pub file_metadata_id: Uuid,
    /// 文件副本在存储服务器中的 uri
    pub server_url: String,
    pub created_time: DateTimeUtc,
    pub created_user_id: Uuid,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "FileMetadataEntity",
        from = "Column::FileMetadataId",
        to = "FileMetadataColumn::Id"
    )]
    FileMetadata,
    #[sea_orm(
        belongs_to = "StorageServerEntity",
        from = "Column::StorageServerId",
        to = "StorageServerColumn::Id"
    )]
    StorageServer,
}

impl ActiveModelBehavior for ActiveModel {}

impl TryFrom<FileStorage> for Model {
    type Error = anyhow::Error;
    fn try_from(l: FileStorage) -> Result<Self, Self::Error> {
        Ok(Self {
            id: Uuid::new_v4(),
            storage_server_id: l.storage_server_id,
            file_metadata_id: l.meta_id,
            server_url: l.server_url,
            created_time: Utc::now(),
            created_user_id: Default::default(),
        })
    }
}

impl From<Model> for FileStorage {
    fn from(val: Model) -> Self {
        FileStorage {
            storage_server_id: val.storage_server_id,
            meta_id: val.file_metadata_id,
            server_url: val.server_url,
        }
    }
}

impl Model {
    pub fn into_set(self) -> ActiveModel {
        ActiveModel {
            id: Set(self.id),
            storage_server_id: Set(self.storage_server_id),
            file_metadata_id: Set(self.file_metadata_id),
            server_url: Set(self.server_url),
            created_time: Set(self.created_time),
            created_user_id: Set(self.created_user_id),
        }
    }
}
