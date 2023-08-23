use crate::prelude::*;
use alice_architecture::repository::IDBRepository;

#[async_trait::async_trait]
pub trait IUserWebhookRepository: IDBRepository<UserWebhook> {
    async fn get_url_by_user_id(&self, id: &str) -> anyhow::Result<String>;
}
