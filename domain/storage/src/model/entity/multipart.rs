use alice_architecture::model::AggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::vo::HashAlgorithm;

/// Multipart upload information.
#[derive(Debug, Serialize, Deserialize, AggregateRoot)]
pub struct Multipart {
    /// File meta id.
    pub meta_id: Uuid,
    /// Multipart's original file hash.
    pub hash: String,
    /// Multipart's original file hash algorithm.
    pub hash_algorithm: HashAlgorithm,
    /// Are parts of the multipart uploaded.
    pub shards: Vec<u64>,
    pub part_count: u64
}
