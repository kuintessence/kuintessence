use std::collections::HashMap;
use std::sync::Arc;

use alice_architecture::{
    background_service::BackgroundService, message_queue::producer::MessageQueueProducerTemplate,
};
use alice_di::*;
use alice_infrastructure::{
    config::CommonConfig,
    data::Database,
    message_queue::{
        InternalMessageQueueConsumer, InternalMessageQueueProducer, KafkaMessageQueueProducer,
    },
    middleware::authorization::{AliceScopedConfig, KeyStorage, MemoryKeyStorage},
    ConsumerFn,
};
use infrastructure_command::WsServerOperateCommand;
use uuid::Uuid;

// domains
use domain_content_repo::{
    repository::PackageRepo,
    service::{NodeDraftService, SoftwareComputingUsecaseInfoService, ValidatePackageService},
};
use domain_storage::{command::ViewRealtimeCommand, repository::MoveRegistrationRepo, service::*};
use domain_workflow::{
    model::{entity::node_instance::NodeInstanceKind, vo::task_dto::Task},
    service::*,
};
// domain services
use super::{
    config::*,
    database::{graphql::content_repo::ContentRepository, OrmRepo, RedisClient, RedisRepo},
    internal_message_consumer,
    service::prelude::*,
    websocket_message_consumer, WsManager, WsSessionOpener,
};
use service_content_repo::*;
use service_storage::*;
use service_workflow::*;

build_container! {
    #[derive(Clone)]
    pub struct ServiceProvider;

    params(config: config::Config)

    scoped_params(scoped_config: AliceScopedConfig)

    scoped user_id: Option<Uuid>{
        build {
            scoped_config.user_info.map(|u|u.id)
        }
    }

    co_config: CoConfig {
        build {
            config.clone().try_deserialize::<CoConfig>()?
        }
    }

    common_config: CommonConfig {
        build {
            co_config.common.clone()
        }
    }

    internal_topics: InternalTopics {
        build {
            co_config.internal_topics.clone()
        }
    }

    internal_message_queue_producer: Arc<InternalMessageQueueProducer> {
        build {
            Arc::new(InternalMessageQueueProducer::new())
        }
    }

    http_client: Arc<reqwest::Client> {
        build {
            alice_infrastructure::http_client::build_http_client(&common_config.http_client)?
        }
    }

    redis_client: Arc<RedisClient> {
        build {
            let initial_nodes = common_config.redis.urls.clone();
            let redis_client: RedisClient = if initial_nodes.len() == 1 {
                RedisClient::Single(redis::Client::open(
                    initial_nodes.first().unwrap().clone(),
                )?)
            } else {
                RedisClient::Cluster(redis::cluster::ClusterClient::new(initial_nodes)?)
            };
            Arc::new(redis_client)
        }
    }

    key_storage: Arc<dyn KeyStorage> {
        build{
            Arc::new(MemoryKeyStorage::new(
                    Arc::new(std::sync::Mutex::new(HashMap::new())),
                    http_client.clone()
                ))
        }
    }

    scoped redis_repository: Arc<RedisRepo> {
        provide[Arc<dyn MoveRegistrationRepo>]
        build {
            Arc::new(
                RedisRepo::builder()
                    .client(self.redis_client.clone())
                    .user_id(user_id)
                    .build(),
            )
        }
    }

    database: Arc<Database> {
        build async {
            Arc::new(Database::new(&common_config.db.url).await)
        }
    }

    scoped sea_orm_repository: Arc<OrmRepo> {
        build {
            Arc::new(
                OrmRepo::builder()
                    .db(sp.provide())
                    .user_id(user_id)
                    .build(),
            )
        }
    }

    package_repo: Arc<dyn PackageRepo> {
        build {
            Arc::new(
                ContentRepository::new(
                    http_client.clone(),
                    co_config.co_repo_domain.clone(),
                )
            )
        }
    }

    co_software_computing_usecase_service: Arc<dyn SoftwareComputingUsecaseInfoService> {
        build {
            Arc::new(SoftwareComputingUsecaseInfoServiceImpl::builder().package_repo(package_repo.clone()).build())
        }
    }

    validate_package_service: Arc<dyn ValidatePackageService> {
        build {
            Arc::new(ValidatePackageServiceImpl)
        }
    }

    node_draft_service: Arc<dyn NodeDraftService> {
        build {
            Arc::new(NodeDraftServiceImpl::builder().package_repo(package_repo.clone()).build())
        }
    }

    kafka_mq_producer: Arc<KafkaMessageQueueProducer> {
        provide[
            Arc<dyn MessageQueueProducerTemplate<ViewRealtimeCommand>>,
            Arc<dyn MessageQueueProducerTemplate<Task>>,
            Arc<dyn MessageQueueProducerTemplate<Uuid>>,
        ]
        build {
            Arc::new(KafkaMessageQueueProducer::new(&common_config.mq.producer))
        }
    }

    cache_service: Arc<dyn CacheService> {
        build {
            Arc::new(
                LocalCacheServiceImpl::builder()
                    .base(&common_config.host.upload_file_path)
                    .build()
            )
        }
    }

    scoped snapshot_service: Arc<dyn SnapshotService> {
        build {
            Arc::new(
                SnapshotServiceImpl::builder()
                    .snapshot_repo(redis_repository.clone())
                    .node_instance_repository(sea_orm_repository.clone())
                    .queue_repository(sea_orm_repository.clone())
                    .mq_producer(self.kafka_mq_producer.clone())
                    .cache_service(self.cache_service.clone())
                    .exp_msecs(self.common_config.redis.exp_msecs)
                    .build()
            )
        }
    }

    scoped meta_storage_service: Arc<dyn MetaStorageService> {
        build {
            Arc::new(
                MetaStorageServiceImpl::builder()
                .meta_repo(sea_orm_repository.clone())
                .storage_repo(sea_orm_repository.clone())
                .build()
            )
        }
    }

    scoped storage_server_broker_service: Arc<dyn StorageServerBrokerService> {
        build {
            Arc::new(
                MinioServerBrokerService::builder()
                    .meta_storage_service(meta_storage_service.clone())
                    .build()
            )
        }
    }

    scoped storage_server_resource_service: Arc<dyn StorageServerResourceService> {
        build {
            Arc::new(
                StorageServerResourceServiceImpl::builder()
                    .default_storage_server_id(self.co_config.default_storage_server_id)
                    .storage_server_repo(sea_orm_repository.clone())
                    .build()
            )
        }
    }

    scoped queue_resource_service: Arc<dyn QueueResourceService> {
        build {
            Arc::new(
                QueueResourceServiceImpl::builder()
                    .queue_resource_repo(sea_orm_repository.clone())
                    .status_mq_producer(self.internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .build()
            )
        }
    }

    scoped storage_server_upload_dispatcher_service: Arc<dyn StorageServerUploadDispatcherService> {
        build {
            Arc::new(
                StorageServerUploadDispatcherServiceImpl::builder()
                    .resources_service(storage_server_resource_service.clone())
                    .storage_server_broker_service(storage_server_broker_service.clone())
                    .build()
            )
        }
    }

    scoped storage_server_download_dispatcher_service: Arc<dyn StorageServerDownloadDispatcherService> {
        build {
            Arc::new(
                StorageServerDownloadDispatcherServiceImpl::builder()
                    .resources_service(storage_server_resource_service.clone())
                    .storage_server_broker_service(storage_server_broker_service.clone())
                    .build()
            )
        }
    }

    scoped net_disk_service: Arc<dyn NetDiskService> {
        build {
            Arc::new(
                NetDiskServiceImpl::builder()
                    .net_disk_repo(sea_orm_repository.clone())
                    .node_instance_repo(sea_orm_repository.clone())
                    .flow_instance_repo(sea_orm_repository.clone())
                    .build()
            )
        }
    }

    scoped multipart_service: Arc<dyn MultipartService> {
        build {
            Arc::new(
                MultipartServiceImpl::builder()
                    .multipart_repo(redis_repository.clone())
                    .cache_service(self.cache_service.clone())
                    .exp_msecs(self.common_config.redis.exp_msecs)
                    .move_registration_repo(redis_repository.clone())
                    .status_mq_producer(self.internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .task_id(scoped_config.task_info.clone().map(|t|t.id))
                    .build()
            )
        }
    }

    scoped file_move_service: Arc<dyn FileMoveService> {
        build {
            Arc::new(
                FileMoveServiceImpl::builder()
                    .move_registration_repo(redis_repository.clone())
                    .snapshot_service(snapshot_service.clone())
                    .upload_sender_and_topic((
                        self.internal_message_queue_producer.clone(),
                        self.internal_topics.file_upload.clone()
                    ))
                    .net_disk_service(net_disk_service.clone())
                    .multipart_service(multipart_service.clone())
                    .meta_storage_service(meta_storage_service.clone())
                    .flow_instance_repo(sea_orm_repository.clone())
                    .exp_msecs(self.common_config.redis.exp_msecs)
                    .user_id(user_id)
                    .task_id(scoped_config.task_info.clone().map(|t|t.id))
                    .build()
            )
        }
    }

    scoped file_upload_runner: Arc<FileUploadRunner> {
        build {
            Arc::new(
                FileUploadRunner::builder()
                    .upload_service(storage_server_upload_dispatcher_service.clone())
                    .cache_service(self.cache_service.clone())
                    .meta_storage_service(meta_storage_service.clone())
                    .net_disk_service(net_disk_service.clone())
                    .file_move_service(file_move_service.clone())
                    .multipart_service(multipart_service.clone())
                    .status_mq_producer(self.internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .build()
            )
        }
    }

    scoped realtime_service: Arc<dyn RealtimeService> {
        build {
            Arc::new(
                RealtimeServiceImpl::builder()
                    .kafka_mq_producer(self.kafka_mq_producer.clone())
                    .node_instance_repository(sea_orm_repository.clone())
                    .queue_repository(sea_orm_repository.clone())
                    .innner_mq_producer(self.internal_message_queue_producer.clone())
                    .ws_server_operate_topic(self.co_config.internal_topics.web_socket.to_owned())
                    .user_id(user_id)
                    .build()
            )
        }
    }

    scoped software_computing_usecase_service: Arc<SoftwareComputingUsecaseServiceImpl> {
        build {
            let internal_message_queue_producer: Arc<InternalMessageQueueProducer> = sp.provide();
            Arc::new(
                SoftwareComputingUsecaseServiceImpl::builder()
                    .computing_usecase_repo(self.co_software_computing_usecase_service.clone())
                    .text_storage_repository(redis_repository.clone())
                    .software_block_list_repository(sea_orm_repository.clone())
                    .installed_software_repository(sea_orm_repository.clone())
                    .queue_resource_service(queue_resource_service.clone())
                    .node_repo(sea_orm_repository.clone())
                    .flow_repo(sea_orm_repository.clone())
                    .task_repo(sea_orm_repository.clone())
                    .status_mq_producer(internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .build()
            )
        }
    }

    no_action_usecase_service: Arc<NoActionUsecaseServiceImpl> {
        build {
            let internal_message_queue_producer: Arc<InternalMessageQueueProducer> = internal_message_queue_producer.clone();
            Arc::new(NoActionUsecaseServiceImpl::builder()
                .status_mq_producer(internal_message_queue_producer)
                .status_mq_topic(co_config.internal_topics.status.to_owned())
                .build()
            )
        }
    }

    scoped milestone_usecase_service: Arc<MilestoneUsecaseServiceImpl>{
        build {
            Arc::new(
                MilestoneUsecaseServiceImpl::new(
                    Arc::new(reqwest::Client::new()),
                    sea_orm_repository.clone()
                )
            )
        }
    }

    scoped usecase_select_service: Arc<dyn UsecaseSelectService> {
        build {
            let mut map: HashMap<NodeInstanceKind, Arc<dyn UsecaseParseService>> = HashMap::new();
            map.insert(self.no_action_usecase_service.get_service_type(), self.no_action_usecase_service.clone());
            map.insert(software_computing_usecase_service.get_service_type(), software_computing_usecase_service.clone());
            // map.insert(script_usecase_service.get_service_type(), script_usecase_service.clone());
            Arc::new(InnerUsecaseSelectService::builder().usecases(map).build())
        }
    }

    scoped task_status_receiver_service: Arc<dyn TaskStatusReceiveService> {
        build {
            let internal_message_queue_producer: Arc<InternalMessageQueueProducer> = self.internal_message_queue_producer.clone();
            Arc::new(
                TaskStatusReceiveServiceImpl::builder()
                    .status_mq_producer(internal_message_queue_producer)
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .queue_resource_service(queue_resource_service.clone())
                    .queue_id(scoped_config.device_info.map(|i|i.id))
                    .build()
            )
        }
    }

    scoped workflow_service: Arc<dyn ControlService> {
        build{
            Arc::new(
                ControlServiceImpl::builder()
                    .draft_repo(sea_orm_repository.clone())
                    .instance_repo(sea_orm_repository.clone())
                    .node_repo(sea_orm_repository.clone())
                    .file_meta_repo(sea_orm_repository.clone())
                    .status_mq_producer(self.internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .build()
            )
        }
    }

    scoped text_storage_service: Arc<dyn TextStorageService> {
        build{
            Arc::new(
                TextStorageServiceImpl::builder()
                    .text_storage_repository(redis_repository.clone())
                    .build()
            )
        }
    }

    background_services: Vec<Arc<dyn BackgroundService>> {
        build {
            let result: Vec<Arc<dyn BackgroundService>> = vec![];
            result
        }
    }

    outer config: config::Config {}

    ws_manager: Arc<WsManager> {
        build {
            Arc::new(WsManager::new(
                internal_message_queue_producer.clone(),
                co_config.web_socket.keep_alive))
        }
    }

    scoped ws_session_opener: Arc<WsSessionOpener> {
        build {
            Arc::new(WsSessionOpener::new(self.ws_manager.clone(), user_id))
        }
    }

    ws_sender: flume::Sender<WsServerOperateCommand> {
        build { ws_manager.command_sender.clone() }
    }

    scoped task_scheduler: Arc<TaskScheduleServiceImpl>{
        build {
            Arc::new(
                TaskScheduleServiceImpl::builder()
                    .task_repo(sea_orm_repository.clone())
                    .mq_producer_task(self.kafka_mq_producer.clone())
                    .status_mq_producer(self.internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .build()
            )
        }
    }

    scoped batch_service: Arc<BatchService>{
        build {
            Arc::new(
                BatchService::builder()
                    .node_instance_repository(sea_orm_repository.clone())
                    .workflow_instance_repository(sea_orm_repository.clone())
                    .file_move_service(file_move_service.clone())
                    .download_service(storage_server_download_dispatcher_service.clone())
                    .text_storage_repository(redis_repository.clone())
                    .build()
            )
        }
    }

    scoped node_scheduler: Arc<NodeScheduleServiceImpl> {
        build {
            Arc::new(
                NodeScheduleServiceImpl::builder()
                    .node_repo(sea_orm_repository.clone())
                    .flow_repo(sea_orm_repository.clone())
                    .task_repo(sea_orm_repository.clone())
                    .status_mq_producer(self.internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .usecase_select_service(usecase_select_service.clone())
                    .batch_service(batch_service.clone())
                    .build()
            )
        }
    }

    scoped flow_scheduler: Arc<FlowScheduleServiceImpl> {
        build {
            Arc::new(
                FlowScheduleServiceImpl::builder()
                    .flow_repo(sea_orm_repository.clone())
                    .node_repo(sea_orm_repository.clone())
                    .batch_service(batch_service.clone())
                    .status_mq_producer(self.internal_message_queue_producer.clone())
                    .status_mq_topic(self.co_config.internal_topics.status.to_owned())
                    .build()
            )
        }
    }

    after_build {
        let arc_sp = Arc::new(sp.clone());
        let mut fn_mapper: HashMap<String, ConsumerFn<ServiceProvider>> = HashMap::new();
        let config: CoConfig = arc_sp.provide();
        let internal_topics = config.internal_topics;
        let ws_server_topic = internal_topics.web_socket.to_owned();
        let file_upload_topic = internal_topics.file_upload.to_owned();
        let status_topic = internal_topics.status.to_owned();

        let realtime_ws_topic = internal_topics.ws_messages.realtime.to_owned();

        // Direct internal message consumer.
        fn_mapper.insert(file_upload_topic, internal_message_consumer::file_upload_runner_consumer);
        fn_mapper.insert(ws_server_topic, internal_message_consumer::ws_server_operator);
        fn_mapper.insert(status_topic, internal_message_consumer::status_consumer);

        // Websocket message consumer.
        fn_mapper.insert(realtime_ws_topic, websocket_message_consumer::ws_realtime);

        let internal_message_queue_producer: Arc<InternalMessageQueueProducer> = arc_sp.provide();
        let mq = Arc::new(InternalMessageQueueConsumer::new(internal_message_queue_producer.get_receiver(), arc_sp, fn_mapper));
        sp.background_services.push(mq);
    }
}
