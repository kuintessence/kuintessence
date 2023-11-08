use alice_architecture::model::AggregateRoot;
use anyhow::bail;
use database_model::storage_server;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Storage server.
#[derive(Debug, Clone, AggregateRoot)]
pub struct StorageServer {
    /// Server id.
    pub id: Uuid,
    /// Server name.
    pub name: String,
    /// Server capacity.
    pub capacity: u64,
    /// Storage type.
    pub storage_type: StorageType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StorageType {
    ObjectStorage {
        #[serde(flatten)]
        options: ObjectServerOption,
    },
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectServerOption {
    pub endpoint: String,
    pub download_endpoint: String,
    pub default_bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub region: String,
}

impl TryFrom<storage_server::Model> for StorageServer {
    type Error = anyhow::Error;

    fn try_from(model: storage_server::Model) -> Result<Self, Self::Error> {
        let storage_server::Model {
            id,
            name,
            options,
            capacity,
            storage_type,
            available_zone_id: _,
        } = model;
        let capacity: u64 = capacity.parse()?;
        let storage_type = if storage_type == 0 {
            StorageType::ObjectStorage {
                options: serde_json::from_value(options)?,
            }
        } else {
            bail!("unsupported storage type");
        };

        Ok(Self {
            id,
            name,
            capacity,
            storage_type,
        })
    }
}
