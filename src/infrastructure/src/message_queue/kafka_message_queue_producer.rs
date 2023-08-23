use crate::ConsumerFn;
use alice_architecture::{
    hosting::IBackgroundService,
    message_queue::{IMessageQueueProducer, IMessageQueueProducerTemplate},
};
use futures_util::StreamExt;
use rdkafka::{
    config::RDKafkaLogLevel,
    consumer::Consumer,
    message::OwnedHeaders,
    producer::{FutureProducer, FutureRecord},
    ClientConfig, Message,
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::runtime::Handle;
use tracing::Instrument;

pub struct KafkaMessageQueue {
    producer: Arc<FutureProducer>,
}

#[async_trait::async_trait]
impl IMessageQueueProducer for KafkaMessageQueue {
    async fn send(&self, content: &str, topic: Option<&str>) -> anyhow::Result<()> {
        match self
            .producer
            .send(
                FutureRecord::to(topic.ok_or(anyhow::anyhow!("no topic"))?)
                    .payload(content)
                    .key("")
                    .headers(OwnedHeaders::new()),
                Duration::from_secs(0),
            )
            .await
        {
            Ok(_) => {}
            Err(_) => anyhow::bail!("Send Error"),
        };
        Ok(())
    }
}

#[async_trait::async_trait]
impl<T> IMessageQueueProducerTemplate<T> for KafkaMessageQueue
where
    T: serde::Serialize + Send + Sync,
{
    async fn send_object(&self, content: &T, topic: Option<&str>) -> anyhow::Result<()> {
        self.send(serde_json::to_string(content)?.as_str(), topic).await
    }
}

impl KafkaMessageQueue {
    pub fn new(client_options: &HashMap<String, String>) -> Self {
        let mut kafka_config = ClientConfig::new();
        for (option_key, option_value) in client_options.iter() {
            kafka_config.set(option_key.as_str(), option_value.as_str());
        }
        kafka_config.set_log_level(RDKafkaLogLevel::Debug);
        Self {
            producer: Arc::new(kafka_config.create().unwrap()),
        }
    }
}

pub struct KafkaMultiTopicMessageQueueConsumer<SP>
where
    SP: Send + Sync + 'static,
{
    topics: HashSet<String>,
    client_options: HashMap<String, String>,
    service_provider: Arc<SP>,
    fn_mapper: HashMap<String, ConsumerFn<SP>>,
}

#[async_trait::async_trait]
impl<SP> IBackgroundService for KafkaMultiTopicMessageQueueConsumer<SP>
where
    SP: Send + Sync + 'static,
{
    async fn run(&self) {
        let mut kafka_config = ClientConfig::new();
        for (option_key, option_value) in self.client_options.iter() {
            kafka_config.set(option_key.as_str(), option_value.as_str());
        }
        kafka_config.set_log_level(RDKafkaLogLevel::Debug);
        let stream_consumer: rdkafka::consumer::StreamConsumer = kafka_config.create().unwrap();
        stream_consumer
            .subscribe(
                self.topics.iter().map(|topic| topic.as_str()).collect::<Vec<&str>>().as_slice(),
            )
            .unwrap();
        let mut stream = stream_consumer.stream();
        log::info!("Kafka starting");
        loop {
            match stream.next().await {
                Some(Ok(borrowed_message)) => {
                    let topic = borrowed_message.topic();
                    let message = (match borrowed_message.payload_view::<str>() {
                        Some(x) => x.unwrap_or("{}"),
                        None => "{}",
                    })
                    .to_string();
                    log::debug!("Message: {}", message);
                    match self.fn_mapper.get(topic) {
                        Some(x) => {
                            let sp = self.service_provider.clone();
                            let x = *x;

                            tokio::task::block_in_place(move || {
                                Handle::current().block_on(
                                    async move {
                                        if let Err(e) = x(message.as_str(), sp.clone()).await {
                                            log::error!("{}", e)
                                        }
                                    }
                                    .instrument(
                                        tracing::trace_span!("kafka_multi_topic_message_queue"),
                                    ),
                                )
                            });
                        }
                        None => log::warn!("No such service: {}.", topic),
                    }
                }
                Some(Err(kafka_error)) => match kafka_error {
                    rdkafka::error::KafkaError::PartitionEOF(partition) => {
                        log::info!("at end of partition {:?}", partition);
                    }
                    _ => log::error!("errors from kafka, {}", kafka_error),
                },
                None => {}
            }
        }
    }
}

impl<SP> KafkaMultiTopicMessageQueueConsumer<SP>
where
    SP: Send + Sync + 'static,
{
    pub fn new(
        topics: Vec<String>,
        client_options: HashMap<String, String>,
        service_provider: Arc<SP>,
        fn_mapper: HashMap<String, ConsumerFn<SP>>,
    ) -> Self {
        let mut new_topics = HashSet::new();
        for topic in topics {
            new_topics.insert(topic.to_string());
        }
        Self {
            topics: new_topics,
            client_options,
            service_provider,
            fn_mapper,
        }
    }
}
pub struct KafkaSingleTopicMessageQueueConsumer<SP>
where
    SP: Send + Sync + 'static,
{
    topics: HashSet<String>,
    client_options: HashMap<String, String>,
    service_provider: Arc<SP>,
    fn_mapper: Vec<ConsumerFn<SP>>,
}

#[async_trait::async_trait]
impl<SP> IBackgroundService for KafkaSingleTopicMessageQueueConsumer<SP>
where
    SP: Send + Sync + 'static,
{
    async fn run(&self) {
        let mut kafka_config = ClientConfig::new();
        for (option_key, option_value) in self.client_options.iter() {
            kafka_config.set(option_key.as_str(), option_value.as_str());
        }
        kafka_config.set_log_level(RDKafkaLogLevel::Debug);
        let stream_consumer: rdkafka::consumer::StreamConsumer = kafka_config.create().unwrap();
        stream_consumer
            .subscribe(
                self.topics.iter().map(|topic| topic.as_str()).collect::<Vec<&str>>().as_slice(),
            )
            .unwrap();
        let mut stream = stream_consumer.stream();
        loop {
            match stream.next().await {
                Some(Ok(borrowed_message)) => {
                    let message = (match borrowed_message.payload_view::<str>() {
                        Some(x) => x.unwrap_or("{}"),
                        None => "{}",
                    })
                    .to_string();
                    log::debug!("Message: {}", message);
                    for x in self.fn_mapper.iter() {
                        let sp = self.service_provider.clone();
                        let x = *x;
                        let message = message.clone();
                        tokio::task::block_in_place(move || {
                            Handle::current().block_on(
                                async move {
                                    if let Err(e) = x(message.as_str(), sp.clone()).await {
                                        log::error!("{}", e)
                                    }
                                }
                                .instrument(tracing::trace_span!(
                                    "kafka_single_topic_message_queue"
                                )),
                            )
                        });
                    }
                }
                Some(Err(kafka_error)) => match kafka_error {
                    rdkafka::error::KafkaError::PartitionEOF(partition) => {
                        log::info!("at end of partition {:?}", partition);
                    }
                    _ => log::error!("errors from kafka, {}", kafka_error),
                },
                None => {}
            }
        }
    }
}

impl<SP> KafkaSingleTopicMessageQueueConsumer<SP>
where
    SP: Send + Sync + 'static,
{
    pub fn new(
        topics: &[String],
        client_options: HashMap<String, String>,
        service_provider: Arc<SP>,
        fn_mapper: Vec<ConsumerFn<SP>>,
    ) -> Self {
        let mut new_topics = HashSet::new();
        for topic in topics {
            new_topics.insert(topic.to_string());
        }
        Self {
            topics: new_topics,
            client_options,
            service_provider,
            fn_mapper,
        }
    }
}
