use crate::prelude::*;

/// Net disk service.
///
/// All same name file in same directory will upload their last_modified_time when they have the same hash,
///
/// and will create new file name with the hash suffix when the hash is different.
#[async_trait]
pub trait INetDiskService {
    /// Create net disk file.
    async fn create_file(&self, command: CreateNetDiskFileCommand) -> Anyhow;
}

pub struct CreateNetDiskFileCommand {
    pub meta_id: Uuid,
    pub file_name: String,
    pub file_type: FileType,
    pub kind: RecordNetDiskKind,
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
