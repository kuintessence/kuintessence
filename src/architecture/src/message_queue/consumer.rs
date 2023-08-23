use std::collections::HashMap;

#[async_trait::async_trait]
pub trait IMessageQueueConsumer {
    fn add_topic(self, topic: &str) -> Self;
    fn add_topics(self, topics: Vec<String>) -> Self;
    fn add_option(self, option_key: &str, option_value: &str) -> Self;
    fn add_options(self, options: HashMap<String, String>) -> Self;
    async fn run(&self) -> ();
}
