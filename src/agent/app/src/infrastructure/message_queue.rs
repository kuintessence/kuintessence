use crate::dtos::Task;
use agent_core::services::ITaskSchedulerService;
use alice_architecture::hosting::IBackgroundService;
use futures::StreamExt;
use rdkafka::{
    config::RDKafkaLogLevel,
    consumer::{Consumer, StreamConsumer},
    error::KafkaError,
    ClientConfig, Message,
};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};
use tracing::Instrument;

pub struct KafkaMessageQueue {
    topics: HashSet<String>,
    client_options: HashMap<String, String>,
    service: Arc<dyn ITaskSchedulerService + Send + Sync>,
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
                    let message: Task = match serde_json::from_str(message) {
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
                                crate::dtos::TaskCommand::Start => {
                                    let message = message.clone();
                                    match service
                                        .enqueue_task(&agent_core::models::Task {
                                            id: message.id,
                                            body: message
                                                .body
                                                .iter()
                                                .map(|x| {
                                                    let mut sub_task =
                                                        agent_core::models::SubTask {
                                                            id: uuid::Uuid::new_v4(),
                                                            parent_id: message.id,
                                                            status: agent_core::models::TaskStatus::Queuing,
                                                            ..Default::default()
                                                        };
                                                    match x {
                                                        crate::dtos::TaskBody::SoftwareDeployment {
                                                            facility_kind,
                                                            command,
                                                        } => {
                                                            sub_task.facility_kind = match facility_kind.clone() {
                                                                crate::dtos::FacilityKind::Spack { name, argument_list } => agent_core::models::FacilityKind::Spack { name, argument_list },
                                                                crate::dtos::FacilityKind::Singularity { image, tag } => agent_core::models::FacilityKind::Singularity { image, tag },
                                                            };
                                                            sub_task.task_type = agent_core::models::TaskType::SoftwareDeployment { status: match command {
                                                                crate::dtos::SoftwareDeploymentCommand::Install => agent_core::models::SoftwareDeploymentStatus::Install,
                                                                crate::dtos::SoftwareDeploymentCommand::Uninstall => agent_core::models::SoftwareDeploymentStatus::Uninstall,
                                                            } };
                                                        },
                                                        crate::dtos::TaskBody::UsecaseExecution {
                                                            name,
                                                            facility_kind,
                                                            arguments,
                                                            environments,
                                                            std_in,
                                                            files,
                                                            requirements,
                                                        } => {
                                                            sub_task.facility_kind = match facility_kind.clone() {
                                                                crate::dtos::FacilityKind::Spack { name, argument_list } => agent_core::models::FacilityKind::Spack { name, argument_list },
                                                                crate::dtos::FacilityKind::Singularity { image, tag } => agent_core::models::FacilityKind::Singularity { image, tag },
                                                            };
                                                            sub_task.requirements = requirements.clone().map(|x| {
                                                                agent_core::models::Requirements { cpu_cores: x.cpu_cores, node_count: x.node_count, max_wall_time: x.max_wall_time, max_cpu_time: x.max_cpu_time, stop_time: x.stop_time }
                                                            });
                                                            sub_task.task_type = agent_core::models::TaskType::UsecaseExecution { name: name.clone(), arguments: arguments.clone(), environments: environments.clone(), std_in: match std_in {
                                                                crate::dtos::StdInKind::Text { text } => agent_core::models::StdInKind::Text { text: text.clone() },
                                                                crate::dtos::StdInKind::File { path } => agent_core::models::StdInKind::File { path: path.clone() },
                                                                crate::dtos::StdInKind::None => agent_core::models::StdInKind::Unknown,
                                                            }, files: files.iter().map(|x| match x.clone() {
                                                                crate::dtos::FileInfo::Input { path, is_package, form } => match form {
                                                                    crate::dtos::InFileForm::Id(id) => agent_core::models::FileInfo {id: uuid::Uuid::new_v4(), metadata_id: id, path, is_package, optional: false, file_type: agent_core::models::FileType::IN, is_generated: false, ..Default::default() },
                                                                    crate::dtos::InFileForm::Content(text) => agent_core::models::FileInfo { id: uuid::Uuid::new_v4(), metadata_id: uuid::Uuid::new_v4(), path, is_package, optional: false, file_type: agent_core::models::FileType::IN, is_generated: true, text }
                                                                },
                                                                crate::dtos::FileInfo::Output { id, path, is_package, optional } => agent_core::models::FileInfo {id: uuid::Uuid::new_v4(), metadata_id: id, path, is_package, optional, file_type: agent_core::models::FileType::OUT, ..Default::default() },
                                                            }).collect::<Vec<agent_core::models::FileInfo>>() }
                                                        },
                                                        crate::dtos::TaskBody::CollectedOut {
                                                            from,
                                                            rule,
                                                            to,
                                                            optional,
                                                        } => {
                                                            sub_task.task_type = agent_core::models::TaskType::CollectedOut { from: match from {
                                                                crate::dtos::CollectFrom::FileOut { path } => agent_core::models::CollectFrom::FileOut { path: path.clone() },
                                                                crate::dtos::CollectFrom::Stdout => agent_core::models::CollectFrom::Stdout,
                                                                crate::dtos::CollectFrom::Stderr => agent_core::models::CollectFrom::Stderr,
                                                            }, rule: match rule.clone() {
                                                                crate::dtos::CollectRule::Regex(exp) => agent_core::models::CollectRule::Regex { exp },
                                                                crate::dtos::CollectRule::BottomLines(n) => agent_core::models::CollectRule::BottomLines { n },
                                                                crate::dtos::CollectRule::TopLines(n) => agent_core::models::CollectRule::TopLines { n },
                                                            }, to: match to.clone() {
                                                                crate::dtos::CollectTo::File { id, path } => agent_core::models::CollectTo::File { id, path },
                                                                crate::dtos::CollectTo::Text { id } => agent_core::models::CollectTo::Text { id },
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
                                crate::dtos::TaskCommand::Pause => {
                                    match service.pause_task(message.id.to_string().as_str()).await
                                    {
                                        Ok(()) => {}
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                                crate::dtos::TaskCommand::Continue => {
                                    match service
                                        .continue_task(message.id.to_string().as_str())
                                        .await
                                    {
                                        Ok(()) => {}
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                                crate::dtos::TaskCommand::Delete => {
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
        service: Arc<dyn ITaskSchedulerService + Send + Sync>,
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
