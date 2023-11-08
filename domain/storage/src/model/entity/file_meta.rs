use alice_architecture::model::AggregateRoot;
use database_model::file_metadata;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::vo::HashAlgorithm;

/// File meta refers to all copies of a same hash file.
///
/// It might be stored on different storage server.
#[derive(Debug, Clone, AggregateRoot)]
// #[cfg_attr(test, derive(Serialize, Deserialize))]
#[derive(Serialize, Deserialize)]
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
    pub size: u64,
}

impl TryFrom<file_metadata::Model> for FileMeta {
    type Error = anyhow::Error;

    fn try_from(model: file_metadata::Model) -> Result<Self, Self::Error> {
        let file_metadata::Model {
            id,
            name,
            hash,
            hash_algorithm,
            size,
            created_time: _,
        } = model;

        Ok(Self {
            id,
            name,
            hash,
            hash_algorithm: hash_algorithm.parse()?,
            size: size as u64,
        })
    }
}
