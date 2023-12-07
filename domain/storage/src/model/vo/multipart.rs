use uuid::Uuid;

/// Part of the multipart.
pub struct Part {
    /// File meta id.
    pub meta_id: Uuid,
    /// Part content.
    pub content: Vec<u8>,
    /// Nth of the multipart.
    pub nth: u64,
}
