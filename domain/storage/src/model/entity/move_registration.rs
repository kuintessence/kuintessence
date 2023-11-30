use alice_architecture::model::AggregateRoot;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::vo::{HashAlgorithm, MoveDestination};

#[derive(Serialize, Deserialize, AggregateRoot)]
/// A pending file move information.
pub struct MoveRegistration {
    pub id: Uuid,
    /// Id of the file to move
    pub meta_id: Uuid,
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: HashAlgorithm,
    pub size: u64,
    /// Destination of the file move.
    pub destination: MoveDestination,
    pub is_upload_failed: bool,
    pub failed_reason: Option<String>,
}
