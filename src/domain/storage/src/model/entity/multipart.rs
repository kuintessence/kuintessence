use alice_architecture::utils::*;
use alice_architecture::IAggregateRoot;

use crate::model::vo::HashAlgorithm;

/// Multipart upload information.
#[derive(Debug, Serialize, Deserialize, IAggregateRoot)]
pub struct Multipart {
    /// File meta id.
    pub meta_id: Uuid,
    /// Multipart's original file hash.
    pub hash: String,
    /// Multipart's original file hash algorithm.
    pub hash_algorithm: HashAlgorithm,
    /// Are parts of the multipart uploaded.
    pub parts: Vec<bool>,
}
