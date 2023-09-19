use std::collections::HashMap;
use std::sync::Arc;

use domain::{
    command::FileTransferCommand,
    model::{
        entity::{
            file::{FileStatus, FileType},
            task::{DeployerType, FacilityKind, TaskStatus, TaskType},
        },
        vo::{
            job::{JobState, ScriptInfo},
            FileTransferStatus, TaskDisplayType,
        },
    },
    repository::{IFileRepository, ISubTaskRepository},
    sender::{IDownloadSender, ISubTaskReportService, IUploadSender},
    service::{JobSchedulerService, RunJobService, SoftwareDeployerService, SubTaskService},
};

pub struct RunJobServiceImpl {
    job_scheduler: Arc<dyn JobSchedulerService>,
    task_repo: Arc<dyn ISubTaskRepository + Send + Sync>,
    task_file_repo: Arc<dyn IFileRepository + Send + Sync>,
    download_sender: Arc<dyn IDownloadSender + Send + Sync>,
    upload_sender: Arc<dyn IUploadSender + Send + Sync>,
    report_service: Arc<dyn ISubTaskReportService>,
    deployers: HashMap<DeployerType, Arc<dyn SoftwareDeployerService>>,
}

#[async_trait::async_trait]
impl SubTaskService for RunJobServiceImpl {
    /// complete
    async fn enqueue_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let mut task = self.task_repo.get_by_id(id).await?;
        let files = self.task_file_repo.find_files_by_task(id).await?;
        let files = files.iter().filter(|x| x.file_type == FileType::IN);
        if files.clone().count() == 0 {
            task.status = TaskStatus::Running;
            self.task_repo.update(task).await?;
            self.task_repo.save_changed().await?;
            return self.internal_run_job(id).await;
        }
        for task_file in files {
            self.task_file_repo
                .update_task_file_status(task_file.id.to_string().as_str(), FileStatus::Downloading)
                .await?;
            self.download_sender
                .send(FileTransferCommand {
                    id: task_file.id,
                    parent_id: task.parent_id,
                    status: FileTransferStatus::Start,
                    task_file: Some(task_file.clone()),
                })
                .await?;
        }
        task.status = TaskStatus::Running;
        self.task_repo.update(task).await?;
        self.task_repo.save_changed().await?;
        Ok(())
    }
    async fn delete_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let task = self.task_repo.get_by_id(id).await?;
        if task.job_id != String::default() {
            self.job_scheduler.delete_job(&task.job_id).await?;
        }
        let _ = self.task_repo.delete_by_id(id, None).await?;
        let _ = self.task_repo.save_changed().await?;
        Ok(())
    }
    async fn pause_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let mut task = self.task_repo.get_by_id(id).await?;
        if task.job_id != String::default() {
            self.job_scheduler.pause_job(&task.job_id).await?;
        }
        if task.status != TaskStatus::Completed || task.status != TaskStatus::Completing {
            task.status = TaskStatus::Suspended;
            let _ = self.task_repo.update(task).await;
            let task_files = self.task_file_repo.find_files_by_task(id).await?;
            for file in task_files {
                if file.file_type == FileType::IN && file.status != FileStatus::Both {
                    self.download_sender
                        .send(FileTransferCommand {
                            id: file.id,
                            parent_id: Default::default(),
                            status: FileTransferStatus::Pause,
                            task_file: None,
                        })
                        .await?;
                }
            }
        }
        let _ = self.task_repo.save_changed().await?;
        Ok(())
    }
    async fn continue_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let mut task = self.task_repo.get_by_id(id).await?;
        if task.job_id != String::default() {
            self.job_scheduler.continue_job(&task.job_id).await?;
        }
        if task.status != TaskStatus::Completed || task.status != TaskStatus::Completing {
            task.status = TaskStatus::Queuing;
            let _ = self.task_repo.update(task).await;
            let task_files = self.task_file_repo.find_files_by_task(id).await?;
            for file in task_files {
                if file.file_type == FileType::IN && file.status != FileStatus::Both {
                    self.download_sender
                        .send(FileTransferCommand {
                            id: file.id,
                            parent_id: Default::default(),
                            status: FileTransferStatus::Continue,
                            task_file: None,
                        })
                        .await?;
                }
            }
        }
        let _ = self.task_repo.save_changed().await?;
        Ok(())
    }
    async fn refresh_all_status(&self) -> anyhow::Result<()> {
        let tasks = self.task_repo.get_all_refreshable_task().await?;
        for task in tasks {
            self.refresh_status(task.id.to_string().as_str()).await?;
        }
        Ok(())
    }
    async fn refresh_status(&self, id: &str) -> anyhow::Result<()> {
        let mut task = self.task_repo.get_by_id(id).await?;
        let job = self.job_scheduler.get_job(&task.job_id).await?;
        task.resource_used = Some(job.resource_used);
        task.status = match job.state {
            JobState::Running | JobState::Suspended | JobState::Queuing | JobState::Completing => {
                TaskStatus::Running
            }
            JobState::Completed => TaskStatus::Completing,
            JobState::Failed | JobState::Unknown => TaskStatus::Failed,
        };
        if task.status == TaskStatus::Running {
            return Ok(());
        }
        if task.status == TaskStatus::Failed {
            task.failed_reason = format!(
                "Job exit with {}\nError Output:\n{}",
                job.exit_status_code, job.error_output
            );
            self.task_repo.update(task).await?;
            self.task_repo.save_changed().await?;
            return self.report_service.report_failed_task(id).await;
        }
        self.task_repo.update(task.clone()).await?;
        self.task_repo.save_changed().await?;
        let files = self.task_file_repo.find_files_by_task(id).await?;
        let files = files.iter().filter(|x| x.file_type == FileType::OUT);
        if files.clone().count() == 0 {
            return self.internal_complete_job(id).await;
        }
        for file in files {
            self.upload_sender
                .send(FileTransferCommand {
                    id: file.id,
                    parent_id: task.parent_id,
                    status: FileTransferStatus::Start,
                    task_file: Some(file.clone()),
                })
                .await?;
            let mut file = file.clone();
            file.status = FileStatus::Uploading;
            self.task_file_repo.update(file).await?;
        }
        self.task_file_repo.save_changed().await?;
        Ok(())
    }
    fn get_task_type(&self) -> TaskDisplayType {
        TaskDisplayType::UsecaseExecution
    }
}

impl RunJobServiceImpl {
    pub fn new(
        job_scheduler: Arc<dyn JobSchedulerService>,
        task_repo: Arc<dyn ISubTaskRepository + Send + Sync>,
        task_file_repo: Arc<dyn IFileRepository + Send + Sync>,
        download_sender: Arc<dyn IDownloadSender + Send + Sync>,
        upload_sender: Arc<dyn IUploadSender + Send + Sync>,
        report_service: Arc<dyn ISubTaskReportService>,
        deployers: HashMap<DeployerType, Arc<dyn SoftwareDeployerService>>,
    ) -> Self {
        Self {
            job_scheduler,
            task_repo,
            task_file_repo,
            download_sender,
            upload_sender,
            report_service,
            deployers,
        }
    }
    async fn internal_run_job(&self, id: &str) -> anyhow::Result<()> {
        let can_run = self
            .task_file_repo
            .find_files_by_task(id)
            .await?
            .iter()
            .filter(|x| x.file_type == FileType::IN)
            .all(|x| x.status == FileStatus::Both);
        if can_run {
            let mut task = self.task_repo.get_by_id(id).await?;
            let mut is_mpi_before_loader = false;
            let load_software = match &task.facility_kind {
                FacilityKind::Spack {
                    name,
                    argument_list,
                } => {
                    match self.deployers.get(&DeployerType::Spack) {
                        Some(x) => {
                            let hash = x.find_installed_hash(name, argument_list).await?;
                            match hash {
                                Some(hash) => x.gen_load_script(&hash),
                                None => {
                                    task.status = TaskStatus::Failed;
                                    task.failed_reason =
                                        "Unabled to load software. No such software.".to_string();
                                    self.task_repo.update(task).await?;
                                    self.task_repo.save_changed().await?;
                                    return self.report_service.report_failed_task(id).await;
                                }
                            }
                        }
                        None => {
                            task.status = TaskStatus::Failed;
                            task.failed_reason = "Unabled to load software. Unable to access software package manager.".to_string();
                            self.task_repo.update(task).await?;
                            self.task_repo.save_changed().await?;
                            return self.report_service.report_failed_task(id).await;
                        }
                    }
                }
                FacilityKind::Singularity { image, tag } => {
                    match self.deployers.get(&DeployerType::Apptainer) {
                        Some(x) => {
                            let hash = x.find_installed_hash(image, &[tag.clone()]).await?;
                            is_mpi_before_loader = true;
                            match hash {
                                Some(hash) => x.gen_load_script(&hash),
                                None => {
                                    task.status = TaskStatus::Failed;
                                    task.failed_reason =
                                        "Unabled to load software. No such software.".to_string();
                                    self.task_repo.update(task).await?;
                                    self.task_repo.save_changed().await?;
                                    return self.report_service.report_failed_task(id).await;
                                }
                            }
                        }
                        None => {
                            task.status = TaskStatus::Failed;
                            task.failed_reason =
                                "Unabled to load software. Unable to access software package manager.".to_string();
                            self.task_repo.update(task).await?;
                            self.task_repo.save_changed().await?;
                            return self.report_service.report_failed_task(id).await;
                        }
                    }
                }
                _ => String::default(),
            };
            match task.task_type.clone() {
                TaskType::UsecaseExecution {
                    arguments,
                    environments,
                    std_in,
                    name,
                    ..
                } => {
                    let info = ScriptInfo {
                        id: task.id.to_string(),
                        name,
                        path: format!("{}/{}", task.parent_id.to_string().as_str(), "run.sh"),
                        load_software,
                        arguments,
                        environments,
                        std_in,
                        parent_id: task.parent_id.to_string(),
                        requirements: task.requirements.clone(),
                        is_mpi_before_loader,
                    };
                    let job_id = self.job_scheduler.submit_job_script(info).await?;
                    task.job_id = job_id;
                    let _ = self.task_repo.update(task).await?;
                }
                _ => anyhow::bail!("Unable to build script info."),
            }
        }
        self.task_file_repo.save_changed().await?;
        Ok(())
    }
    async fn internal_complete_job(&self, id: &str) -> anyhow::Result<()> {
        let can_run = self
            .task_file_repo
            .find_files_by_task(id)
            .await?
            .iter()
            .filter(|x| x.file_type == FileType::OUT)
            .all(|x| x.status == FileStatus::Both);
        if can_run {
            self.report_service.report_completed_task(id).await?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl RunJobService for RunJobServiceImpl {
    async fn run_job(&self, id: &str) -> anyhow::Result<()> {
        let task_file = self.task_file_repo.get_by_id(id).await?;
        self.task_file_repo.update_task_file_status(id, FileStatus::Both).await?;
        self.task_file_repo.save_changed().await?;
        self.internal_run_job(task_file.related_task_body.to_string().as_str()).await
    }
    async fn complete_job(&self, id: &str) -> anyhow::Result<()> {
        let task_file = self.task_file_repo.get_by_id(id).await?;
        self.task_file_repo.update_task_file_status(id, FileStatus::Both).await?;
        self.task_file_repo.save_changed().await?;
        self.internal_complete_job(task_file.related_task_body.to_string().as_str())
            .await
    }
    async fn fail_job(&self, id: &str, reason: &str) -> anyhow::Result<()> {
        let mut task = self.task_repo.get_by_id(id).await?;
        task.status = TaskStatus::Failed;
        task.failed_reason = reason.to_string();
        self.task_repo.update(task).await?;
        self.task_repo.save_changed().await?;
        return self.report_service.report_failed_task(id).await;
    }
}
