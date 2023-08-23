//! 文件网盘
use crate::system::prelude::*;
use chrono::Utc;
use kernel::prelude::{NetDisk, NetDiskMeta};
use num_traits::FromPrimitive;
use sea_orm::{
    entity::prelude::*,
    ActiveValue::{NotSet, Set, Unchanged},
};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "file_system")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub name: String,
    pub is_dict: bool,
    /// 文件种类（用于预览）
    /// 文件夹时为 null
    pub kind: i32,
    pub owner_id: Uuid,
    pub created_time: DateTimeUtc,
    /// 文件夹时为 null
    pub file_metadata_id: Option<Uuid>,
    #[sea_orm(column_type = "JsonBinary")]
    pub meta: Option<Json>,
}
#[test]
fn sdaf() {
    let x = Model {
        id: Uuid::new_v4(),
        parent_id: None,
        name: "assdf".to_string(),
        is_dict: true,
        kind: 2,
        owner_id: Uuid::new_v4(),
        created_time: Utc::now(),
        file_metadata_id: None,
        meta: None,
    };
    let y = ActiveModel::from(x);
    println!("{y:#?}");
    let y = y.reset_all();
    println!("{y:#?}");
}
#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "FileMetadataEntity",
        from = "Column::FileMetadataId",
        to = "FileMetadataColumn::Id"
    )]
    FileMetadata,
    #[sea_orm(belongs_to = "Entity", from = "Column::ParentId", to = "Column::Id")]
    SelfReferencing,
}

impl Related<FileMetadataEntity> for Entity {
    fn to() -> RelationDef {
        Relation::FileMetadata.def()
    }
}

pub struct SelfReferencingLink;

impl Linked for SelfReferencingLink {
    type FromEntity = Entity;

    type ToEntity = Entity;

    fn link(&self) -> Vec<RelationDef> {
        vec![Relation::SelfReferencing.def()]
    }
}

impl ActiveModelBehavior for ActiveModel {}

impl TryFrom<NetDisk> for Model {
    type Error = anyhow::Error;

    fn try_from(l: NetDisk) -> Result<Self, Self::Error> {
        Ok(Self {
            id: l.id,
            parent_id: l.parent_id,
            name: l.name,
            is_dict: l.is_dict,
            kind: l.kind as i32,
            owner_id: Default::default(),
            created_time: Utc::now(),
            file_metadata_id: l.file_metadata_id,
            meta: match l.meta {
                Some(el) => Some(serde_json::to_value(el)?),
                None => None,
            },
        })
    }
}

impl TryInto<NetDisk> for Model {
    type Error = anyhow::Error;
    fn try_into(self) -> Result<NetDisk, Self::Error> {
        Ok(NetDisk {
            id: self.id,
            parent_id: self.parent_id,
            name: self.name,
            is_dict: self.is_dict,
            kind: FromPrimitive::from_i32(self.kind)
                .ok_or(anyhow::anyhow!("File system kind error."))?,
            file_metadata_id: self.file_metadata_id,
            meta: self.meta.map(serde_json::from_value::<NetDiskMeta>).transpose()?,
            user_id: Some(self.owner_id),
        })
    }
}

impl Model {
    pub fn into_insert(self) -> ActiveModel {
        ActiveModel {
            id: Set(self.id),
            parent_id: Set(self.parent_id),
            name: Set(self.name),
            is_dict: Set(self.is_dict),
            kind: Set(self.kind),
            owner_id: Set(self.owner_id),
            created_time: NotSet,
            file_metadata_id: Set(self.file_metadata_id),
            meta: match self.meta {
                Some(_) => Set(self.meta),
                None => NotSet,
            },
        }
    }
    pub fn into_update(self) -> ActiveModel {
        ActiveModel {
            id: Unchanged(self.id),
            parent_id: Unchanged(self.parent_id),
            name: Unchanged(self.name),
            is_dict: Unchanged(self.is_dict),
            kind: Unchanged(self.kind),
            owner_id: Unchanged(self.owner_id),
            created_time: Unchanged(self.created_time),
            file_metadata_id: Unchanged(self.file_metadata_id),
            meta: Unchanged(self.meta),
        }
    }
}
