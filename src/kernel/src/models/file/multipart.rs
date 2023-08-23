use crate::prelude::*;
use alice_architecture::IAggregateRoot;

impl IAggregateRoot for Multipart {}

/// Multipart upload information.
#[derive(Serialize, Deserialize, Debug)]
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
