use serde::{Deserialize, Serialize};
use uuid::Uuid;

impl alice_architecture::model::IAggregateRoot for UserWebhook {}
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct UserWebhook {
    pub id: Uuid,
    pub user_id: Uuid,
    pub url: String,
}
