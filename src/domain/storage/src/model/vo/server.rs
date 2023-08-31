use uuid::Uuid;

/// The relative file storted url on the server.
pub struct ServerUrl {
    pub bucket: String,
    pub storage_server_id: Uuid,
    pub meta_id: Uuid,
}

impl std::fmt::Display for ServerUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Self {
            bucket,
            storage_server_id,
            meta_id,
        } = self;
        write!(f, "{bucket}/storage-{storage_server_id}/{meta_id}")
    }
}
