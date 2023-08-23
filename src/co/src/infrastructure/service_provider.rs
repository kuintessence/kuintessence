use super::{
    external_services::{
        FileUploadRunnerBuilder, IFileUploadRunner, InnerUsecaseSelectServiceBuilder,
        MinioServerBrokerServiceBuilder,
    },
    repositories::{
        redis_repository::{RedisClient, RedisRepository, RedisRepositoryBuilder},
        sea_orm_db_repository::{SeaOrmDbRepository, SeaOrmDbRepositoryBuilder},
    },
    ws::{manager::WsManager, IWsManager},
    FileSystemConfig,
};
use crate::{controllers, infrastructure::CoConfig, internal_message_consumers};
use alice_architecture::{
    hosting::IBackgroundService, message_queue::IMessageQueueProducerTemplate,
};
use alice_di::*;
use alice_infrastructure::{
    config::CommonConfig,
    data::db::Database,
    message_queue::{
        InternalMessageQueueConsumer, InternalMessageQueueProducer, KafkaMessageQueue,
    },
    middleware::authorization::{IKeyStorage, KeyStorage},
    ConsumerFn,
};
use kernel::prelude::*;
use lib_co_repo::client::{CoRepoClientBuilder, IInfoGetter};
use std::collections::HashMap;
use tokio::sync::Mutex;

build_container! {
    #[derive(Clone)]
    pub struct ServiceProvider;
    params(config: config::Config)
    scoped_params(user_info: Option<alice_architecture::authorization::UserInfo>)
    scoped user_id: Option<String>{
        build {
           user_info.map(|el|el.user_id)
        }
    }
    co_config: CoConfig {
        build {
            let co_config: CoConfig = config.clone().try_deserialize()?;
            co_config
        }
    }
    common_config: CommonConfig {
        build {
            co_config.common().clone()
        }
    }
    file_system_config: FileSystemConfig {
        build {
            co_config.file_system().clone()
        }
    }
    http_client: Arc<reqwest::Client> {
        build {
            super::build_http_client(co_config.http_client())?
        }
    }
    redis_client: Arc<RedisClient> {
        build {
            let initial_nodes = common_config.redis().urls().clone();
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
    key_storage: Arc<dyn IKeyStorage + Send + Sync> {
        build{
            Arc::new(KeyStorage::new(Arc::new(std::sync::Mutex::new(HashMap::new()))))
        }
    }
    scoped redis_repository: Arc<RedisRepository> {
        provide[Arc<dyn IMoveRegistrationRepo + Send + Sync>]
        build {
            Arc::new(
                RedisRepositoryBuilder::default()
                    .client(self.redis_client.clone())
                    .user_id(user_id.clone())
                    .build()?,
            )
        }
    }
    redis_repository2: Arc<dyn IWsReqInfoRepo + Send + Sync> {
        build {
            Arc::new(
                RedisRepositoryBuilder::default()
                    .client(redis_client.clone())
                    .build()?,
            )
        }
    }
    database: Arc<Database> {
        build async {
            Arc::new(Database::new(common_config.db().url()).await)
        }
    }
    scoped sea_orm_repository: Arc<SeaOrmDbRepository> {
        build {
            Arc::new(
                SeaOrmDbRepositoryBuilder::default()
                    .db(sp.provide())
                    .user_id(user_id.clone())
                    .build()?,
            )
        }
    }
    kafka_mq_producer: Arc<KafkaMessageQueue> {
        provide[Arc<dyn IMessageQueueProducerTemplate<ViewRealtimeCommand> + Send + Sync>, Arc<dyn IMessageQueueProducerTemplate<Task> + Send + Sync>, Arc<dyn IMessageQueueProducerTemplate<NodeInstanceId> + Send + Sync>]
        build {
            Arc::new(KafkaMessageQueue::new(common_config.mq().client_options()))
        }
    }
    scoped cache_service: Arc<dyn ICacheService + Send + Sync> {
        build {
            Arc::new(
                LocalCacheServiceBuilder::default()
                .base(self.file_system_config.cache_base())
                .build()?
            )
        }
    }
    scoped snapshot_service: Arc<dyn ISnapshotService + Send + Sync> {
        build {
            Arc::new(
                SnapshotServiceBuilder::default()
                .snapshot_repo(redis_repository.clone())
                .mq_producer(self.kafka_mq_producer.clone())
                .cache_service(cache_service.clone())
                .exp_msecs(*self.file_system_config.snapshot().exp_msecs())
                .snapshot_topic(self.file_system_config.snapshot().request_topic().clone())
                .build()?
            )
        }
    }
    scoped meta_storage_service: Arc<dyn IMetaStorageService> {
        build {
            Arc::new(
                MetaStorageServiceBuilder::default()
                .meta_repo(sea_orm_repository.clone())
                .storage_repo(sea_orm_repository.clone())
                .build()?
            )
        }
    }
    scoped storage_server_broker_service: Arc<dyn IStorageServerBrokerService> {
        build {
            Arc::new(
                MinioServerBrokerServiceBuilder::default()
                .meta_storage_service(meta_storage_service.clone())
                .build()?
            )
        }
    }
    scoped resources_service: Arc<dyn IResourcesService> {
        build {
            Arc::new(
                ResourcesServiceBuilder::default()
                .default_storage_server_id(*self.co_config.default_storage_server_id())
                .storage_server_repo(sea_orm_repository.clone())
                .build()?
            )
        }
    }
    scoped storage_server_upload_dispatcher_service: Arc<dyn IStorageServerUploadDispatcherService + Sync + Send> {
        build {
            Arc::new(
                StorageServerUploadDispatcherServiceBuilder::default()
                .resources_service(resources_service.clone())
                .storage_server_broker_service(storage_server_broker_service.clone())
                .build()?
            )
        }
    }
    scoped storage_server_download_dispatcher_service: Arc<dyn IStorageServerDownloadDispatcherService + Sync + Send> {
        build {
            Arc::new(
                StorageServerDownloadDispatcherServiceBuilder::default()
                .resources_service(resources_service.clone())
                .storage_server_broker_service(storage_server_broker_service.clone())
                .build()?
            )
        }
    }
    scoped net_disk_service: Arc<dyn INetDiskService + Send + Sync> {
        build {
            Arc::new(
                NetDiskServiceBuilder::default()
                .net_disk_repo(sea_orm_repository.clone())
                .flow_draft_repo(sea_orm_repository.clone())
                .node_instance_repo(sea_orm_repository.clone())
                .flow_instance_repo(sea_orm_repository.clone())
                .build()?
            )
        }
    }

    scoped multipart_service: Arc<dyn IMultipartService + Send + Sync> {
        build {
            Arc::new(
                MultipartServiceBuilder::default()
                .multipart_repo(redis_repository.clone())
                .cache_service(cache_service.clone())
                .exp_msecs(*self.file_system_config.multipart().exp_msecs())
                .build()?
            )
        }
    }
    scoped file_move_service: Arc<dyn IFileMoveService + Send + Sync> {
        build {
            Arc::new(
                FileMoveServiceBuilder::default()
                .move_registration_repo(redis_repository.clone())
                .snapshot_service(snapshot_service.clone())
                .upload_sender_and_topic((self.internal_message_queue_producer.clone(),self.file_system_config.file_move().file_upload_topic().to_owned()))
                .net_disk_service(net_disk_service.clone())
                .multipart_service(multipart_service.clone())
                .meta_storage_service(meta_storage_service.clone())
                .exp_msecs(*self.file_system_config.file_move().exp_msecs())
                .build()?
            )
        }
    }
    scoped file_upload_runner: Arc<dyn IFileUploadRunner + Send + Sync> {
        build {
            Arc::new(
                FileUploadRunnerBuilder::default()
                .upload_service(storage_server_upload_dispatcher_service.clone())
                .cache_service(cache_service.clone())
                .meta_storage_service(meta_storage_service.clone())
                .net_disk_service(net_disk_service.clone())
                .file_move_service(file_move_service.clone())
                .multipart_service(multipart_service.clone())
                .build()?
            )
        }
    }
    scoped realtime_service: Arc<dyn IRealtimeService + Send + Sync> {
        build {
            Arc::new(
                RealtimeServiceBuilder::default()
                .kafka_mq_producer(self.kafka_mq_producer.clone())
                .ws_file_redis_repo(redis_repository.clone())
                .innner_mq_producer(self.internal_message_queue_producer.clone())
                .realtime_request_topic(self.file_system_config.realtime().request_topic().to_owned())
                .ws_server_operate_topic(self.file_system_config.realtime().ws_topic().to_owned())
                .exp_msecs(*self.file_system_config.realtime().exp_msecs())
                .build()?
            )
        }
    }

    scoped task_distribution_service: Arc<dyn ITaskDistributionService + Send + Sync> {
        build {
            Arc::new(
                TaskDistributionServiceBuilder::default()
                    .cluster_repository(sea_orm_repository.clone())
                    .mqproducer(sp.provide())
                    .build()?,
            )
        }
    }
    scoped software_computing_usecase_service: Arc<SoftwareComputingUsecaseService>{
        build{
            Arc::new(
                SoftwareComputingUsecaseServiceBuilder::default()
                .computing_usecase_getter(self.corepoclient.clone())
                .text_storage_repository(redis_repository.clone())
                .task_distribution_service(task_distribution_service.clone())
                .software_block_list_repository(sea_orm_repository.clone())
                .installed_software_repository(sea_orm_repository.clone())
                .cluster_repository(sea_orm_repository.clone())
                .node_instance_repository(sea_orm_repository.clone())
                .workflow_instance_repository(sea_orm_repository.clone())
                .build()?
            )
        }
    }
    scoped no_action_usecase_service: Arc<NoActionUsecaseService> {
        build {
            let internal_message_queue_producer: Arc<InternalMessageQueueProducer> = sp.provide();
            Arc::new(NoActionUsecaseService::new(internal_message_queue_producer))
        }
    }
    scoped script_usecase_service: Arc<ScriptUsecaseService> {
        build {
            Arc::new(ScriptUsecaseService::new(
                task_distribution_service.clone(),
                sea_orm_repository.clone(),
                sea_orm_repository.clone(),
            ))
        }
    }
    scoped milestone_usecase_service: Arc<MilestoneUsecaseService>{
        build{
            Arc::new(MilestoneUsecaseService::new(
                Arc::new(reqwest::Client::new()),
                sea_orm_repository.clone()))
        }
    }
    scoped usecase_select_service: Arc<dyn IUsecaseSelectService + Send + Sync> {
        build {
            let mut map: HashMap<kernel::models::prelude::NodeInstanceKind, Arc<dyn IUsecaseService + Send + Sync>> = HashMap::new();
            map.insert(no_action_usecase_service.get_service_type(), no_action_usecase_service.clone());
            map.insert(software_computing_usecase_service.get_service_type(), software_computing_usecase_service.clone());
            map.insert(script_usecase_service.get_service_type(), script_usecase_service.clone());
            Arc::new(
                InnerUsecaseSelectServiceBuilder::default()
                .usecases(map)
                .build()?
            )
        }
    }
    scoped workflow_schedule_service: Arc<dyn IWorkflowScheduleService + Send + Sync> {
        build {
            Arc::new(
                WorkflowScheduleServiceBuilder::default()
                .node_instance_repository(sea_orm_repository.clone())
                .workflow_instance_repository(sea_orm_repository.clone())
                .file_move_service(file_move_service.clone())
                .download_service(storage_server_download_dispatcher_service.clone())
                .usecase_select_service(usecase_select_service.clone())
                .text_storage_repository(redis_repository.clone())
                .build()?
            )
        }
    }
    scoped workflow_status_receiver_service: Arc<dyn IWorkflowStatusReceiverService + Send + Sync> {
        build {
            Arc::new(
                WorkflowStatusReceiverServiceBuilder::default()
                .node_instance_repository(sea_orm_repository.clone())
                .workflow_instance_repository(sea_orm_repository.clone())
                .schedule_service(workflow_schedule_service.clone())
                .mq_producer(self.kafka_mq_producer.to_owned())
                .bill_topic(self.co_config.bill_topic().to_owned())
                .build()?
            )
        }
    }
    scoped workflow_service: Arc<dyn IWorkflowService + Send + Sync> {
        build{
            Arc::new(
                WorkflowServiceBuilder::default()
                .workflow_draft_repository(sea_orm_repository.clone())
                .workflow_instance_repository(sea_orm_repository.clone())
                .node_instance_repository(sea_orm_repository.clone())
                .file_metadata_repository(sea_orm_repository.clone())
                .workflow_schedule_service(workflow_schedule_service.clone())
                .build()?
            )
        }
    }
    scoped text_storage_service: Arc<dyn ITextStorageService + Send + Sync> {
        build{
            Arc::new(
                TextStorageServiceBuilder::default()
                .text_storage_repository(redis_repository.clone())
                .build()?
            )
        }
    }
    corepoclient: Arc<dyn IInfoGetter + Send + Sync> {
        build {
            Arc::new(
                CoRepoClientBuilder::default()
                    .client(http_client.clone())
                    .co_repo_url(co_config.co_repo_domain().to_owned())
                    .build()?,
            )
        }
    }

    background_services: Vec<Arc<dyn IBackgroundService + Send + Sync>> {
        build {
            let result: Vec<Arc<dyn IBackgroundService + Send + Sync>> = vec![];
            result
        }
    }
    outer config: config::Config {}
    internal_message_queue_producer: Arc<InternalMessageQueueProducer> {
        build {
            Arc::new(InternalMessageQueueProducer::new())
        }
    }
    ws_manager: Arc<Mutex<dyn IWsManager + Send + Sync>> {
        build {
            Arc::new(Mutex::new(WsManager::new(internal_message_queue_producer.clone(), redis_repository2.clone(), file_system_config.realtime().request_topic().to_owned())))
        }
    }
    ws_sender: flume::Sender<WsServerOperateCommand> {
        build {
            ws_manager.lock().await.ws_server_sender.clone()
        }
    }

    after_build {
        let arc_sp = Arc::new(sp.clone());
        let mut fn_mapper: HashMap<String, ConsumerFn<ServiceProvider>> = HashMap::new();
        let ws_server_topic = arc_sp.file_system_config.realtime().ws_topic().to_owned();
        let realtime_request_topic = arc_sp.file_system_config.realtime().request_topic().to_owned();
        let file_upload_topic = arc_sp.file_system_config.file_move().file_upload_topic().to_string();
        fn_mapper.insert("node_status".to_string(), controllers::workflow_engine::node_status_consumer);
        fn_mapper.insert(file_upload_topic, internal_message_consumers::file_upload_runner_consumer);
        fn_mapper.insert(realtime_request_topic, internal_message_consumers::realtime_file_consumer);
        fn_mapper.insert(ws_server_topic, internal_message_consumers::ws_server_file_consumer);
        let internal_message_queue_producer: Arc<InternalMessageQueueProducer> = arc_sp.provide();
        let mq = Arc::new(InternalMessageQueueConsumer::new(internal_message_queue_producer.get_receiver(), arc_sp, fn_mapper));
        sp.background_services.push(mq);
    }
}
