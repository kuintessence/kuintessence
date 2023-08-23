use billing_system_kernel::prelude::*;
use std::{str::FromStr, sync::Arc};
use uuid::Uuid;

pub struct UserWebhookService {
    user_webhook_repo: Arc<dyn IUserWebhookRepository + Send + Sync>,
    client: Arc<reqwest::Client>,
}

impl UserWebhookService {
    pub fn new(
        user_webhook_repo: Arc<dyn IUserWebhookRepository + Send + Sync>,
        client: Arc<reqwest::Client>,
    ) -> Self {
        Self {
            user_webhook_repo,
            client,
        }
    }
}

#[async_trait::async_trait]
impl IUserWebhookService for UserWebhookService {
    async fn register_webhook(&self, user_id: &str, url: &str) -> anyhow::Result<()> {
        let user_webhook = UserWebhook {
            id: Uuid::new_v4(),
            user_id: Uuid::from_str(user_id)?,
            url: url.to_owned(),
        };
        self.user_webhook_repo.insert(user_webhook).await?;
        self.user_webhook_repo.save_changed().await?;
        Ok(())
    }
    async fn send_message(&self, user_id: &str, message: &str) -> anyhow::Result<()> {
        let url = self.user_webhook_repo.get_url_by_user_id(user_id).await?;

        let response = self.client.post(url).json(message).send().await?;
        let response_text = response.text().await?;
        println!("finish send");
        println!("{response_text}");
        Ok(())
    }
}
