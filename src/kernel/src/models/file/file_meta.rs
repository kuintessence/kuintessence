use crate::prelude::*;
use alice_architecture::IAggregateRoot;

impl IAggregateRoot for FileMeta {}

/// File meta refers to all copies of a same hash file.
///
/// It might be stored on different storage server.
#[derive(Debug, Clone)]
#[cfg_attr(test, derive(Serialize, Deserialize))]
pub struct FileMeta {
    /// Id.
    pub id: Uuid,
    /// File meta's easy to remember name.
    pub name: String,
    /// Hash of these files.
    pub hash: String,
    /// Hash algorithm of these files.
    pub hash_algorithm: HashAlgorithm,
    /// Size of these files.
    pub size: usize,
}
