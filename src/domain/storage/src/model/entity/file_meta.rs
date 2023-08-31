use alice_architecture::utils::*;
use alice_architecture::IAggregateRoot;
use chrono::Utc;
use database_model::system::prelude::FileMetadataModel;

use crate::model::vo::HashAlgorithm;

/// File meta refers to all copies of a same hash file.
///
/// It might be stored on different storage server.
#[derive(Debug, Clone, IAggregateRoot)]
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
    pub size: usize,
}

impl TryFrom<FileMetadataModel> for FileMeta {
    type Error = anyhow::Error;

    fn try_from(model: FileMetadataModel) -> Result<Self, Self::Error> {
        let FileMetadataModel {
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
            size: size as usize,
        })
    }
}

impl From<FileMeta> for FileMetadataModel {
    fn from(value: FileMeta) -> Self {
        let FileMeta {
            id,
            name,
            hash,
            hash_algorithm,
            size,
        } = value;

        Self {
            id,
            name,
            hash,
            hash_algorithm: hash_algorithm.to_string(),
            size: size as i64,
            created_time: Utc::now(),
        }
    }
}
