use super::{
    extra_services::{
        job_schedulers::{PBSClient, SlurmClient},
        software_deployers::{apptainer::ApptainerDeployer, spack::SpackDeployer},
    },
    file_download_runner::{DownloadSender, FileDownloadRunner},
    file_load_service::FileLoadService,
    file_system_watch_runner::FileSystemWatchRunner,
    file_upload_runner::{FileUploadRunner, UploadSender},
    http_client::HttpClient,
    interval_runner::IntervalRunner,
    message_queue::KafkaMessageQueue,
    repositories::JSONRepository,
    software_deployment_runner::{SoftwareDeploymentRunner, SoftwareDeploymentSender},
    task_scheduler_runner::{SubTaskReportService, TaskSchedulerRunner},
    token,
};
use agent_core::{
    models::{DeployerType, TaskDisplayType},
    services::{
        CollectionTaskService, DeploySoftwareService, IDeploySoftwareService, IDownloadSender,
        IFileLoadService, IJobSchedulerService, IRunJobService, ISoftwareDeployerService,
        ISoftwareDeploymentSender, ISubTaskReportService, ISubTaskService, ITaskSchedulerService,
        IUploadSender, RunJobService, TaskSchedulerService,
    },
};
use alice_architecture::hosting::IBackgroundService;
use alice_di::*;
use std::{collections::HashMap, path::Path, sync::Arc};

build_container! {
    #[derive(Clone)]
    pub struct ServiceProvider;
    params(config: config::Config)
    common_config: alice_infrastructure::config::CommonConfig {
        build {
            let common_config: alice_infrastructure::config::CommonConfig = config.get("common").unwrap_or_default();
            common_config
        }
    }
    agent_config: crate::config::AgentConfig {
        build {
            let agent_config: crate::config::AgentConfig = config.get("agent").unwrap_or_default();
            agent_config
        }
    }
    repository: Arc<JSONRepository> {
        build async {
            Arc::new(JSONRepository::new(common_config.db().url()).await?)
        }
    }
    job_scheduler: Arc<dyn IJobSchedulerService + Send + Sync> {
        build async {
            let path = Path::new(agent_config.include_env_script_path.as_str());
            let include_env = if path.is_file() {
                tokio::fs::read_to_string(path).await.unwrap_or_default()
            } else {
                agent_config.include_env_script.clone()
            };
            let result: Arc<dyn IJobSchedulerService + Send + Sync> = match agent_config.scheduler.r#type.to_lowercase().as_str() {
                "pbs" => Arc::new(PBSClient::new(agent_config.save_path.clone(), include_env, agent_config.ssh_proxy.clone())),
                "slurm" => Arc::new(SlurmClient::new(agent_config.save_path.clone(), include_env, agent_config.ssh_proxy.clone())),
                _ => {
                    anyhow::bail!("job.scheduler.type hasn't been configured.")
                }
            };
            result
        }
    }
    download_sender: Arc<DownloadSender> {
        provide [Arc<dyn IDownloadSender + Send + Sync>]
        build {
            Arc::new(DownloadSender::new())
        }
    }
    upload_sender: Arc<UploadSender> {
        provide [Arc<dyn IUploadSender + Send + Sync>]
        build {
            Arc::new(UploadSender::new())
        }
    }
    deploy_sender: Arc<SoftwareDeploymentSender> {
        provide [Arc<dyn ISoftwareDeploymentSender + Send + Sync>]
        build {
            Arc::new(SoftwareDeploymentSender::new())
        }
    }
    http_client: Arc<reqwest::Client> {
        build {
            Arc::new(reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(2)).build()?)
        }
    }
    sub_task_report_service: Arc<SubTaskReportService> {
        provide [Arc<dyn ISubTaskReportService + Send + Sync>]
        build {
            Arc::new(SubTaskReportService::new())
        }
    }
    spack_deployer_service: Arc<SpackDeployer> {
        build {
            Arc::new(SpackDeployer::new(agent_config.ssh_proxy.clone()))
        }
    }
    apptainer_deployer_service: Arc<ApptainerDeployer> {
        build {
            Arc::new(ApptainerDeployer::new("apptainer".to_string(), agent_config.container_save_path.clone(), None, agent_config.ssh_proxy.clone()))
        }
    }
    deployers: HashMap<DeployerType, Arc<dyn ISoftwareDeployerService + Send + Sync>> {
        build {
            let mut deployers: HashMap<DeployerType, Arc<dyn ISoftwareDeployerService + Send + Sync>> = HashMap::new();
            deployers.insert(spack_deployer_service.get_deployer_type(), spack_deployer_service.clone());
            deployers.insert(apptainer_deployer_service.get_deployer_type(), apptainer_deployer_service.clone());
            deployers
        }
    }
    run_task_service: Arc<dyn IRunJobService + Send + Sync> {
        build {
            Arc::new(RunJobService::new(
                job_scheduler.clone(),
                repository.clone(),
                repository.clone(),
                download_sender.clone(),
                upload_sender.clone(),
                sub_task_report_service.clone(),
                deployers.clone()
            ))
        }
    }
    deploy_software_service: Arc<dyn IDeploySoftwareService + Send + Sync> {
        build {
            Arc::new(DeploySoftwareService::new(repository.clone(), sub_task_report_service.clone(), deploy_sender.clone(), deployers.clone()))
        }
    }
    software_deployment_runner: Arc<SoftwareDeploymentRunner> {
        build {
            Arc::new(SoftwareDeploymentRunner::new(deploy_sender.get_receiver(), deploy_software_service.clone()))
        }
    }
    file_load_service: Arc<dyn IFileLoadService + Send + Sync> {
        build {
            Arc::new(FileLoadService::new(agent_config.save_path.clone(), http_client.clone(), agent_config.upload_base_url.clone(), agent_config.ssh_proxy.clone()))
        }
    }
    collection_task_service: Arc<CollectionTaskService> {
        build {
            Arc::new(CollectionTaskService::new(repository.clone(), sub_task_report_service.clone(), file_load_service.clone()))
        }
    }
    task_scheduler_service: Arc<dyn ITaskSchedulerService + Send + Sync> {
        build {
            let mut sub_task_services: HashMap<TaskDisplayType, Arc<dyn ISubTaskService + Sync + Send>> = HashMap::new();
            sub_task_services.insert(run_task_service.get_task_type(), run_task_service.clone());
            sub_task_services.insert(deploy_software_service.get_task_type(), deploy_software_service.clone());
            sub_task_services.insert(collection_task_service.get_task_type(), collection_task_service.clone());
            Arc::new(
                TaskSchedulerService::new(
                    repository.clone(),
                    repository.clone(),
                    Arc::new(
                        HttpClient::new(
                            http_client.clone(),
                            agent_config.report_url.parse().unwrap(),
                            repository.clone(),
                        )
                    ),
                    sub_task_services,
                    0,
                )
            )
        }
    }
    task_scheduler_runner: Arc<TaskSchedulerRunner> {
        build {
            Arc::new(TaskSchedulerRunner::new(sub_task_report_service.get_receiver(), task_scheduler_service.clone()))
        }
    }
    file_download_runner: Arc<FileDownloadRunner> {
        build {
            Arc::new(FileDownloadRunner::new(
                agent_config.save_path.clone(),
                download_sender.get_receiver(),
                http_client.clone(),
                agent_config.download_base_url.clone(),
                run_task_service.clone(),
                agent_config.ssh_proxy.clone(),
            ))
        }
    }
    file_upload_runner: Arc<FileUploadRunner> {
        build {
            Arc::new(FileUploadRunner::new(
                agent_config.save_path.clone(),
                agent_config.upload_base_url.clone(),
                upload_sender.get_receiver(),
                run_task_service.clone(),
                http_client.clone(),
                agent_config.ssh_proxy.clone(),
            ))
        }
    }
    file_system_watch_runner: Arc<FileSystemWatchRunner> {
        build {
            Arc::new(FileSystemWatchRunner::new(agent_config.save_path.clone(), run_task_service.clone(), agent_config.ssh_proxy.clone()))
        }
    }
    interval_runner: Arc<IntervalRunner> {
        build {
            Arc::new(IntervalRunner::new(agent_config.watch_interval, task_scheduler_service.clone(), run_task_service.clone()))
        }
    }
    message_queue: Arc<KafkaMessageQueue> {
        build {
            // TODO: 创建新队列
            // bin/kafka-topics.sh --create --topic quickstart-events --bootstrap-server localhost:9092
            let client_options = common_config.mq().client_options().clone();
            let mut topics = common_config.mq().topics().clone();
            // It is safe to parse the token into `AgentId` after login
            topics.push(token::get().payload().unwrap().preferred_username);
            Arc::new(
                KafkaMessageQueue::new(
                    task_scheduler_service.clone(),
                    topics,
                    client_options,
                )
            )
        }
    }
    background_services: Vec<Arc<dyn IBackgroundService + Send + Sync>> {
        build {
            let result: Vec<Arc<dyn IBackgroundService + Send + Sync>> =
                vec![
                    file_download_runner.clone(),
                    file_upload_runner.clone(),
                    file_system_watch_runner.clone(),
                    interval_runner.clone(),
                    message_queue.clone(),
                    task_scheduler_runner.clone(),
                    software_deployment_runner.clone(),
                ];
            result
        }
    }
    outer config: config::Config {}
}
