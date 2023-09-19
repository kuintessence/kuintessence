use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use alice_architecture::hosting::IBackgroundService;
use alice_di::*;
use domain::{
    model::{entity::task::DeployerType, vo::TaskDisplayType},
    sender::*,
    service::*,
};
use service::prelude::*;
use url::Url;

use super::{
    http_client::HttpClient,
    repository::JSONRepository,
    resource::ResourceStat,
    service::{
        file_load_service::FileLoadServiceImpl,
        job_schedulers::{PBSClient, SlurmClient},
        software_deployers::{apptainer::ApptainerDeployer, spack::SpackDeployer},
    },
    ssh_proxy::SshProxy,
    token::TokenManager,
};
use crate::background_service::{
    file_download_runner::DownloadSender, file_upload_runner::UploadSender,
    software_deployment_runner::SoftwareDeploymentSender,
    task_scheduler_runner::SubTaskReportService,
};
use crate::background_service::{prelude::*, resource_reporter::ResourceReporter};

build_container! {
    #[derive(Clone)]
    pub struct ServiceProvider;
    params(
        config: config::Config,
        ssh_proxy: Arc<SshProxy>,
        token_manager: Arc<TokenManager>,
        topic: String,
        resource_stat: Arc<ResourceStat>
    )
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
    job_scheduler: Arc<dyn JobSchedulerService> {
        build async {
            let path = Path::new(agent_config.include_env_script_path.as_str());
            let include_env = if path.is_file() {
                tokio::fs::read_to_string(path).await.unwrap_or_default()
            } else {
                agent_config.include_env_script.clone()
            };
            let result: Arc<dyn JobSchedulerService> = match agent_config.scheduler.r#type.to_lowercase().as_str() {
                "pbs" => Arc::new(PBSClient::new(agent_config.save_path.clone(), include_env, ssh_proxy.clone())),
                "slurm" => Arc::new(SlurmClient::new(agent_config.save_path.clone(), include_env, ssh_proxy.clone())),
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
    http_client: reqwest::Client {
        build {
            reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(2))
                .build()?
        }
    }
    sub_task_report_service: Arc<SubTaskReportService> {
        provide [Arc<dyn ISubTaskReportService>]
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
    deployers: HashMap<DeployerType, Arc<dyn SoftwareDeployerService>> {
        build {
            let mut deployers: HashMap<DeployerType, Arc<dyn SoftwareDeployerService>> = HashMap::new();
            deployers.insert(spack_deployer_service.get_deployer_type(), spack_deployer_service.clone());
            deployers.insert(apptainer_deployer_service.get_deployer_type(), apptainer_deployer_service.clone());
            deployers
        }
    }
    run_task_service: Arc<dyn RunJobService> {
        build {
            Arc::new(RunJobServiceImpl::new(
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
    deploy_software_service: Arc<dyn DeploySoftwareService> {
        build {
            Arc::new(DeploySoftwareServiceImpl::new(repository.clone(), sub_task_report_service.clone(), deploy_sender.clone(), deployers.clone()))
        }
    }
    software_deployment_runner: Arc<SoftwareDeploymentRunner> {
        build {
            Arc::new(SoftwareDeploymentRunner::new(deploy_sender.get_receiver(), deploy_software_service.clone()))
        }
    }
    file_load_service: Arc<dyn FileLoadService> {
        build {
            Arc::new(
                FileLoadServiceImpl::new(
                    agent_config.save_path.clone(),
                    http_client.clone(),
                    agent_config.upload_base_url.clone(),
                    agent_config.ssh_proxy.clone(),
            ))
        }
    }
    collection_task_service: Arc<CollectionTaskServiceImpl> {
        build {
            Arc::new(CollectionTaskServiceImpl::new(repository.clone(), sub_task_report_service.clone(), file_load_service.clone()))
        }
    }
    task_scheduler_service: Arc<dyn TaskSchedulerService> {
        build {
            let mut sub_task_services: HashMap<TaskDisplayType, Arc<dyn SubTaskService + Sync + Send>> = HashMap::new();
            sub_task_services.insert(run_task_service.get_task_type(), run_task_service.clone());
            sub_task_services.insert(deploy_software_service.get_task_type(), deploy_software_service.clone());
            sub_task_services.insert(collection_task_service.get_task_type(), collection_task_service.clone());
            Arc::new(
                TaskSchedulerServiceImpl::new(
                    repository.clone(),
                    repository.clone(),
                    Arc::new(HttpClient::builder()
                        .base(http_client.clone())
                        .base_url(agent_config.report_url.parse().unwrap())
                        .token_manager(token_manager.clone())
                        .repo(repository.clone())
                        .build()
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
            let client_options = common_config.mq().client_options().clone();
            let mut topics = common_config.mq().topics().clone();
            topics.push(topic);
            Arc::new(KafkaMessageQueue::new(
                task_scheduler_service.clone(),
                topics,
                client_options,
            ))
        }
    }
    resource_reporter: Arc<ResourceReporter> {
        build {
            Arc::new(ResourceReporter::builder()
                .update_url(agent_config.report_url.parse::<Url>()?.join("/agent/UpdateUsedResource")?)
                .http_client(http_client.clone())
                .token_manager(token_manager.clone())
                .stat(resource_stat.clone())
                .build()
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
                    resource_reporter.clone(),
                ];
            result
        }
    }
    outer config: config::Config {}
}
