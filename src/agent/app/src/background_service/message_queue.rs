use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use alice_architecture::hosting::IBackgroundService;
use domain::{
    model::entity::{
        file::FileType,
        task::{
            CollectFrom, CollectRule, CollectTo, FacilityKind, FileInfo, Requirements,
            SoftwareDeploymentStatus, StdInKind, TaskStatus, TaskType,
        },
        SubTask, Task,
    },
    service::TaskSchedulerService,
};
use futures::StreamExt;
use rdkafka::{
    config::RDKafkaLogLevel,
    consumer::{Consumer, StreamConsumer},
    error::KafkaError,
    ClientConfig, Message,
};
use tracing::Instrument;

pub struct KafkaMessageQueue {
    topics: HashSet<String>,
    client_options: HashMap<String, String>,
    service: Arc<dyn TaskSchedulerService>,
}

#[async_trait::async_trait]
impl IBackgroundService for KafkaMessageQueue {
    async fn run(&self) -> () {
        let mut kafka_config = ClientConfig::new();
        for (option_key, option_value) in self.client_options.iter() {
            kafka_config.set(option_key.as_str(), option_value.as_str());
        }
        kafka_config.set_log_level(RDKafkaLogLevel::Debug);
        let stream_consumer: StreamConsumer = kafka_config.create().unwrap();
        stream_consumer
            .subscribe(
                self.topics.iter().map(|topic| topic.as_str()).collect::<Vec<&str>>().as_slice(),
            )
            .unwrap();
        let mut stream = stream_consumer.stream();
        loop {
            match stream.next().await {
                Some(Ok(borrowed_message)) => {
                    let message = match borrowed_message.payload_view::<str>() {
                        Some(x) => x.unwrap_or("{}"),
                        None => "{}",
                    };
                    log::debug!("Message: {}", message);
                    let message: crate::dto::Task = match serde_json::from_str(message) {
                        Ok(x) => x,
                        Err(e) => {
                            log::error!("{}", e);
                            continue;
                        }
                    };
                    let service = self.service.clone();
                    tokio::spawn(
                        async move {
                            log::debug!("Message: {:#?}", message);
                            match message.command {
                                crate::dto::TaskCommand::Start => {
                                    let message = message.clone();
                                    match service
                                        .enqueue_task(&Task {
                                            id: message.id,
                                            body: message
                                                .body
                                                .iter()
                                                .map(|x| {
                                                    let mut sub_task =
                                                        SubTask {
                                                            id: uuid::Uuid::new_v4(),
                                                            parent_id: message.id,
                                                            status: TaskStatus::Queuing,
                                                            ..Default::default()
                                                        };
                                                    match x {
                                                        crate::dto::TaskBody::SoftwareDeployment {
                                                            facility_kind,
                                                            command,
                                                        } => {
                                                            sub_task.facility_kind = match facility_kind.clone() {
                                                                crate::dto::FacilityKind::Spack { name, argument_list } => FacilityKind::Spack { name, argument_list },
                                                                crate::dto::FacilityKind::Singularity { image, tag } => FacilityKind::Singularity { image, tag },
                                                            };
                                                            sub_task.task_type = TaskType::SoftwareDeployment { status: match command {
                                                                crate::dto::SoftwareDeploymentCommand::Install => SoftwareDeploymentStatus::Install,
                                                                crate::dto::SoftwareDeploymentCommand::Uninstall => SoftwareDeploymentStatus::Uninstall,
                                                            } };
                                                        },
                                                        crate::dto::TaskBody::UsecaseExecution {
                                                            name,
                                                            facility_kind,
                                                            arguments,
                                                            environments,
                                                            std_in,
                                                            files,
                                                            requirements,
                                                        } => {
                                                            sub_task.facility_kind = match facility_kind.clone() {
                                                                crate::dto::FacilityKind::Spack { name, argument_list } => FacilityKind::Spack { name, argument_list },
                                                                crate::dto::FacilityKind::Singularity { image, tag } => FacilityKind::Singularity { image, tag },
                                                            };
                                                            sub_task.requirements = requirements.clone().map(|x| {
                                                                Requirements { cpu_cores: x.cpu_cores, node_count: x.node_count, max_wall_time: x.max_wall_time, max_cpu_time: x.max_cpu_time, stop_time: x.stop_time }
                                                            });
                                                            sub_task.task_type = TaskType::UsecaseExecution { name: name.clone(), arguments: arguments.clone(), environments: environments.clone(), std_in: match std_in {
                                                                crate::dto::StdInKind::Text { text } => StdInKind::Text { text: text.clone() },
                                                                crate::dto::StdInKind::File { path } => StdInKind::File { path: path.clone() },
                                                                crate::dto::StdInKind::None => StdInKind::Unknown,
                                                            }, files: files.iter().map(|x| match x.clone() {
                                                                crate::dto::FileInfo::Input { path, is_package, form } => match form {
                                                                    crate::dto::InFileForm::Id(id) => FileInfo {id: uuid::Uuid::new_v4(), metadata_id: id, path, is_package, optional: false, file_type: FileType::IN, is_generated: false, ..Default::default() },
                                                                    crate::dto::InFileForm::Content(text) => FileInfo { id: uuid::Uuid::new_v4(), metadata_id: uuid::Uuid::new_v4(), path, is_package, optional: false, file_type: FileType::IN, is_generated: true, text }
                                                                },
                                                                crate::dto::FileInfo::Output { id, path, is_package, optional } => FileInfo {id: uuid::Uuid::new_v4(), metadata_id: id, path, is_package, optional, file_type: FileType::OUT, ..Default::default() },
                                                            }).collect::<Vec<FileInfo>>() }
                                                        },
                                                        crate::dto::TaskBody::CollectedOut {
                                                            from,
                                                            rule,
                                                            to,
                                                            optional,
                                                        } => {
                                                            sub_task.task_type = TaskType::CollectedOut { from: match from {
                                                                crate::dto::CollectFrom::FileOut { path } => CollectFrom::FileOut { path: path.clone() },
                                                                crate::dto::CollectFrom::Stdout => CollectFrom::Stdout,
                                                                crate::dto::CollectFrom::Stderr => CollectFrom::Stderr,
                                                            }, rule: match rule.clone() {
                                                                crate::dto::CollectRule::Regex(exp) => CollectRule::Regex { exp },
                                                                crate::dto::CollectRule::BottomLines(n) => CollectRule::BottomLines { n },
                                                                crate::dto::CollectRule::TopLines(n) => CollectRule::TopLines { n },
                                                            }, to: match to.clone() {
                                                                crate::dto::CollectTo::File { id, path } => CollectTo::File { id, path },
                                                                crate::dto::CollectTo::Text { id } => CollectTo::Text { id },
                                                            }, optional: *optional }
                                                        },
                                                    }
                                                    sub_task
                                                })
                                                .collect(),
                                            update_time: chrono::Utc::now(),
                                            ..Default::default()
                                        })
                                        .await
                                    {
                                        Ok(()) => {}
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                                crate::dto::TaskCommand::Pause => {
                                    match service.pause_task(message.id.to_string().as_str()).await
                                    {
                                        Ok(()) => {}
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                                crate::dto::TaskCommand::Continue => {
                                    match service
                                        .continue_task(message.id.to_string().as_str())
                                        .await
                                    {
                                        Ok(()) => {}
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                                crate::dto::TaskCommand::Delete => {
                                    match service.delete_task(message.id.to_string().as_str(), false).await
                                    {
                                        Ok(()) => {}
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                            }
                        }
                        .instrument(tracing::trace_span!("kafka_message_queue")),
                    );
                }
                Some(Err(kafka_error)) => match kafka_error {
                    KafkaError::PartitionEOF(partition) => {
                        log::info!("at end of partition {:?}", partition);
                    }
                    _ => log::error!("errors from kafka, {}", kafka_error),
                },
                None => {}
            }
        }
    }
}

impl KafkaMessageQueue {
    pub fn new(
        service: Arc<dyn TaskSchedulerService>,
        topics: Vec<String>,
        client_options: HashMap<String, String>,
    ) -> Self {
        let mut new_topics = HashSet::new();
        for topic in topics {
            new_topics.insert(topic.to_string());
        }
        Self {
            topics: new_topics,
            client_options,
            service,
        }
    }
}
