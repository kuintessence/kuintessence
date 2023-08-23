use serde::*;
#[async_trait::async_trait]
pub trait IMessageQueueProducer {
    /// 发送数据
    async fn send(&self, content: &str, topic: Option<&str>) -> anyhow::Result<()>;
}

#[async_trait::async_trait]
pub trait IMessageQueueProducerTemplate<T>
where
    T: Serialize + Send + Sync,
{
    async fn send_object(&self, content: &T, topic: Option<&str>) -> anyhow::Result<()>;
}
