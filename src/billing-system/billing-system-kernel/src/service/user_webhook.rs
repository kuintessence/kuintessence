#[async_trait::async_trait]
pub trait IUserWebhookService {
    /// 注册
    async fn register_webhook(&self, user_id: &str, url: &str) -> anyhow::Result<()>;
    /// 发布消息
    async fn send_message(&self, user_id: &str, message: &str) -> anyhow::Result<()>;
}
