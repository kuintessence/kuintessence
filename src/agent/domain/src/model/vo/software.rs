use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::model::entity::SoftwareInstallOptions;

#[derive(Default, Deserialize, Serialize, Clone, PartialEq, Eq, Debug)]
pub struct LocalSoftware {
    pub id: Uuid,
    pub options: SoftwareInstallOptions,
}
