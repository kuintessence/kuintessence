use std::collections::HashMap;
use std::sync::Arc;

use domain::{
    command::SoftwareDeploymentCommand,
    model::{
        entity::{
            task::{DeployerType, FacilityKind, TaskStatus},
            SubTask,
        },
        vo::TaskDisplayType,
    },
    repository::ISubTaskRepository,
    sender::{ISoftwareDeploymentSender, ISubTaskReportService},
    service::{DeploySoftwareService, SoftwareDeployerService, SubTaskService},
};

pub struct DeploySoftwareServiceImpl {
    sub_task_repo: Arc<dyn ISubTaskRepository + Send + Sync>,
    report_service: Arc<dyn ISubTaskReportService>,
    sender: Arc<dyn ISoftwareDeploymentSender + Send + Sync>,
    deployers: HashMap<DeployerType, Arc<dyn SoftwareDeployerService>>,
}

#[async_trait::async_trait]
impl SubTaskService for DeploySoftwareServiceImpl {
    async fn enqueue_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.sub_task_repo.get_by_id(id).await?;
        self.sender
            .send(SoftwareDeploymentCommand {
                id: sub_task.id,
                task_status: TaskStatus::Running,
            })
            .await?;
        self.sub_task_repo
            .update(SubTask {
                status: TaskStatus::Running,
                ..sub_task
            })
            .await?;
        self.sub_task_repo.save_changed().await?;
        Ok(())
    }
    async fn delete_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.sub_task_repo.get_by_id(id).await?;
        self.sender
            .send(SoftwareDeploymentCommand {
                id: sub_task.id,
                task_status: TaskStatus::Suspended,
            })
            .await?;
        self.sub_task_repo.delete_by_id(id, None).await?;
        self.sub_task_repo.save_changed().await?;
        Ok(())
    }
    async fn pause_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.sub_task_repo.get_by_id(id).await?;
        self.sender
            .send(SoftwareDeploymentCommand {
                id: sub_task.id,
                task_status: TaskStatus::Suspended,
            })
            .await?;
        self.sub_task_repo
            .update(SubTask {
                status: TaskStatus::Suspended,
                ..sub_task
            })
            .await?;
        self.sub_task_repo.save_changed().await?;
        Ok(())
    }
    async fn continue_sub_task(&self, id: &str) -> anyhow::Result<()> {
        self.enqueue_sub_task(id).await
    }
    async fn refresh_all_status(&self) -> anyhow::Result<()> {
        Ok(())
    }
    async fn refresh_status(&self, _id: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn get_task_type(&self) -> TaskDisplayType {
        TaskDisplayType::SoftwareDeployment
    }
}

#[async_trait::async_trait]
impl DeploySoftwareService for DeploySoftwareServiceImpl {
    async fn complete_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.sub_task_repo.get_by_id(id).await?;
        self.sub_task_repo
            .update(SubTask {
                status: TaskStatus::Completed,
                ..sub_task
            })
            .await?;
        self.sub_task_repo.save_changed().await?;
        self.report_service.report_completed_task(id).await
    }
    async fn fail_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.sub_task_repo.get_by_id(id).await?;
        self.sub_task_repo
            .update(SubTask {
                status: TaskStatus::Failed,
                ..sub_task
            })
            .await?;
        self.sub_task_repo.save_changed().await?;
        self.report_service.report_failed_task(id).await
    }
    async fn run_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.sub_task_repo.get_by_id(id).await?;
        match &sub_task.facility_kind {
            FacilityKind::Spack {
                name,
                argument_list,
            } => match self.deployers.get(&DeployerType::Spack) {
                Some(x) => {
                    if let Ok(Some(_)) = x.find_installed_hash(name, argument_list).await {
                        self.sender
                            .send(SoftwareDeploymentCommand {
                                id: sub_task.id,
                                task_status: TaskStatus::Completing,
                            })
                            .await?;
                        return Ok(());
                    }
                    match x.install(name, argument_list.clone()).await {
                        Ok(_) => {
                            self.sender
                                .send(SoftwareDeploymentCommand {
                                    id: sub_task.id,
                                    task_status: TaskStatus::Completing,
                                })
                                .await
                        }
                        Err(e) => {
                            self.sub_task_repo
                                .update(SubTask {
                                    failed_reason: format!("{e}"),
                                    ..sub_task
                                })
                                .await?;
                            self.sub_task_repo.save_changed().await?;
                            self.sender
                                .send(SoftwareDeploymentCommand {
                                    id: sub_task.id,
                                    task_status: TaskStatus::Failed,
                                })
                                .await
                        }
                    }
                }
                None => {
                    self.sub_task_repo
                        .update(SubTask {
                            failed_reason: "No such package manager.".to_string(),
                            ..sub_task
                        })
                        .await?;
                    self.sub_task_repo.save_changed().await?;
                    self.sender
                        .send(SoftwareDeploymentCommand {
                            id: sub_task.id,
                            task_status: TaskStatus::Failed,
                        })
                        .await
                }
            },
            FacilityKind::Singularity { image, tag } => {
                match self.deployers.get(&DeployerType::Apptainer) {
                    Some(x) => {
                        let tag = vec![tag.clone()];
                        if let Ok(Some(_)) = x.find_installed_hash(image, &tag).await {
                            self.sender
                                .send(SoftwareDeploymentCommand {
                                    id: sub_task.id,
                                    task_status: TaskStatus::Completing,
                                })
                                .await?;
                            return Ok(());
                        }
                        match x.install(image, tag).await {
                            Ok(_) => {
                                self.sender
                                    .send(SoftwareDeploymentCommand {
                                        id: sub_task.id,
                                        task_status: TaskStatus::Completing,
                                    })
                                    .await
                            }
                            Err(e) => {
                                self.sub_task_repo
                                    .update(SubTask {
                                        failed_reason: format!("{e}"),
                                        ..sub_task
                                    })
                                    .await?;
                                self.sub_task_repo.save_changed().await?;
                                self.sender
                                    .send(SoftwareDeploymentCommand {
                                        id: sub_task.id,
                                        task_status: TaskStatus::Failed,
                                    })
                                    .await
                            }
                        }
                    }
                    None => {
                        self.sub_task_repo
                            .update(SubTask {
                                failed_reason: "No such package manager.".to_string(),
                                ..sub_task
                            })
                            .await?;
                        self.sub_task_repo.save_changed().await?;
                        self.sender
                            .send(SoftwareDeploymentCommand {
                                id: sub_task.id,
                                task_status: TaskStatus::Failed,
                            })
                            .await
                    }
                }
            }
            _ => {
                self.sub_task_repo
                    .update(SubTask {
                        failed_reason: "No such package manager.".to_string(),
                        ..sub_task
                    })
                    .await?;
                self.sub_task_repo.save_changed().await?;
                self.sender
                    .send(SoftwareDeploymentCommand {
                        id: sub_task.id,
                        task_status: TaskStatus::Failed,
                    })
                    .await
            }
        }
    }
}

impl DeploySoftwareServiceImpl {
    pub fn new(
        sub_task_repo: Arc<dyn ISubTaskRepository + Send + Sync>,
        report_service: Arc<dyn ISubTaskReportService>,
        sender: Arc<dyn ISoftwareDeploymentSender + Send + Sync>,
        deployers: HashMap<DeployerType, Arc<dyn SoftwareDeployerService>>,
    ) -> Self {
        Self {
            sub_task_repo,
            report_service,
            sender,
            deployers,
        }
    }
}
