use alice_architecture::model::derive::AggregateRoot;
use chrono::Utc;
use database_model::system::prelude::FileSystemModel;
use num_derive::{FromPrimitive, ToPrimitive};
use num_traits::FromPrimitive;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Net disk record.
#[derive(Debug, Clone, AggregateRoot)]
pub struct NetDisk {
    /// Net disk file id.
    pub id: Uuid,
    /// parent dir id.
    pub parent_id: Option<Uuid>,
    /// Net disk file name.
    pub name: String,
    /// Is record a directory.
    pub is_dict: bool,
    /// Net disk file kind.
    pub kind: FileType,
    /// Reference file meta id.
    pub file_metadata_id: Option<Uuid>,
    /// Metadata.
    pub meta: Option<NetDiskMeta>,
}

/// Net disk meta.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetDiskMeta {
    /// Belongs to flow draft.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_draft_id: Option<Uuid>,
    /// Belongs to flow instance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_instance_id: Option<Uuid>,
    /// Belongs to node instance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_instance_id: Option<Uuid>,
    /// As root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir_kind: Option<DirKind>,
}

/// Root kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DirKind {
    /// Flow draft dir.
    FlowDraft,
    /// Flow instance dir.
    FlowInstance,
    /// Node instance dir.
    NodeInstance,
}

/// File type.
#[derive(FromPrimitive, ToPrimitive, Debug, Clone, Serialize, Deserialize)]
pub enum FileType {
    Unkonwn,
    Text,
    Folder,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RecordNetDiskKind {
    /// Move to node instance dir.
    #[serde(rename_all = "camelCase")]
    NodeInstance { node_id: Uuid },
    /// Move to flow draft dir.
    #[serde(rename_all = "camelCase")]
    FlowDraft { flow_draft_id: Uuid },
    /// Move to user specified dir.
    #[serde(rename_all = "camelCase")]
    Normal { parent_id: Option<Uuid> },
}

impl NetDisk {
    pub fn flow_draft_root(root_id: Uuid) -> Self {
        Self {
            id: Uuid::default(),
            parent_id: Some(root_id),
            name: "来自工作流草稿".to_string(),
            is_dict: true,
            kind: FileType::Folder,
            file_metadata_id: None,
            meta: Some(NetDiskMeta {
                dir_kind: Some(DirKind::FlowDraft),
                ..Default::default()
            }),
        }
    }

    pub fn flow_instance_root(root_id: Uuid) -> Self {
        Self {
            id: Uuid::default(),
            parent_id: Some(root_id),
            name: "来自工作流实例".to_string(),
            is_dict: true,
            kind: FileType::Folder,
            file_metadata_id: None,
            meta: Some(NetDiskMeta {
                dir_kind: Some(DirKind::FlowInstance),
                ..Default::default()
            }),
        }
    }

    pub fn flow_draft_dir(draft_root_id: Uuid, draft_id: Uuid, draft_name: &str) -> Self {
        Self {
            id: draft_id,
            parent_id: Some(draft_root_id),
            name: format!(
                "{draft_name}_{}",
                draft_id.to_string().split('-').next().unwrap()
            ),
            is_dict: true,
            kind: FileType::Folder,
            file_metadata_id: None,
            meta: Some(NetDiskMeta {
                flow_draft_id: Some(draft_id),
                dir_kind: Some(DirKind::FlowDraft),
                ..Default::default()
            }),
        }
    }

    pub fn flow_instance_dir(
        instance_root_id: Uuid,
        instance_id: Uuid,
        instance_name: &str,
    ) -> Self {
        Self {
            id: instance_id,
            parent_id: Some(instance_root_id),
            name: format!(
                "{instance_name}_{}",
                instance_id.to_string().split('-').next().unwrap()
            ),
            is_dict: true,
            kind: FileType::Folder,
            file_metadata_id: None,
            meta: Some(NetDiskMeta {
                flow_instance_id: Some(instance_id),
                dir_kind: Some(DirKind::FlowInstance),
                ..Default::default()
            }),
        }
    }

    pub fn node_instance_dir(
        flow_instance_dir_id: Uuid,
        flow_id: Uuid,
        instance_id: Uuid,
        instance_name: &str,
    ) -> Self {
        Self {
            id: instance_id,
            parent_id: Some(flow_instance_dir_id),
            name: format!(
                "{instance_name}_{}",
                instance_id.to_string().split('-').next().unwrap()
            ),
            is_dict: true,
            kind: FileType::Folder,
            file_metadata_id: None,
            meta: Some(NetDiskMeta {
                flow_instance_id: Some(flow_id),
                node_instance_id: Some(instance_id),
                dir_kind: Some(DirKind::NodeInstance),
                ..Default::default()
            }),
        }
    }
}

impl TryFrom<FileSystemModel> for NetDisk {
    type Error = anyhow::Error;

    fn try_from(model: FileSystemModel) -> Result<Self, Self::Error> {
        let FileSystemModel {
            id,
            parent_id,
            name,
            is_dict,
            kind,
            owner_id: _,
            created_time: _,
            file_metadata_id,
            meta,
        } = model;

        Ok(Self {
            id,
            parent_id,
            name,
            is_dict,
            file_metadata_id,
            kind: FileType::from_i32(kind).ok_or(anyhow::anyhow!("File system kind error"))?,
            meta: meta.map(serde_json::from_value).transpose()?,
        })
    }
}

impl TryFrom<NetDisk> for FileSystemModel {
    type Error = anyhow::Error;

    fn try_from(value: NetDisk) -> Result<Self, Self::Error> {
        let NetDisk {
            id,
            parent_id,
            name,
            is_dict,
            kind,
            file_metadata_id,
            meta,
        } = value;

        Ok(Self {
            id,
            parent_id,
            name,
            is_dict,
            kind: kind as i32,
            owner_id: Uuid::default(),
            created_time: Utc::now(),
            file_metadata_id,
            meta: meta.map(serde_json::to_value).transpose()?,
        })
    }
}
