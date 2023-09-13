use alice_architecture::model::derive::AggregateRoot;
use chrono::Utc;
use database_model::system::prelude::FileStorageModel;
use uuid::Uuid;

/// Record File meta and its stored server.
#[derive(Debug, Clone, AggregateRoot)]
pub struct FileStorage {
    /// Storage server id.
    pub storage_server_id: Uuid,
    /// File meta id.
    pub meta_id: Uuid,
    /// The relative url on the server.
    pub server_url: String,
}

impl From<FileStorageModel> for FileStorage {
    #[inline]
    fn from(model: FileStorageModel) -> Self {
        Self {
            storage_server_id: model.storage_server_id,
            meta_id: model.file_metadata_id,
            server_url: model.server_url,
        }
    }
}

impl From<FileStorage> for FileStorageModel {
    fn from(value: FileStorage) -> Self {
        Self {
            id: Uuid::new_v4(),
            storage_server_id: value.storage_server_id,
            file_metadata_id: value.meta_id,
            server_url: value.server_url,
            created_time: Some(Utc::now().into()),
            created_user_id: Uuid::default(),
        }
    }
}
