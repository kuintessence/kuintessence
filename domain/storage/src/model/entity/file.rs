use alice_architecture::model::AggregateRoot;
use database_model::file_storage;
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

impl From<file_storage::Model> for FileStorage {
    #[inline]
    fn from(model: file_storage::Model) -> Self {
        Self {
            storage_server_id: model.storage_server_id,
            meta_id: model.file_metadata_id,
            server_url: model.server_url,
        }
    }
}
