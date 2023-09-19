use std::collections::HashMap;
use std::sync::atomic::AtomicU32;

use anyhow::Context;
use domain::{
    model::{
        entity::{task::TaskStatus, SubTask, Task},
        vo::TaskDisplayType,
    },
    repository::{ISubTaskRepository, ITaskRepository},
    service::{SubTaskService, TaskReportService, TaskSchedulerService},
};
use uuid::Uuid;

pub struct TaskSchedulerServiceImpl {
    repo: std::sync::Arc<dyn ITaskRepository + Sync + Send>,
    sub_repo: std::sync::Arc<dyn ISubTaskRepository + Sync + Send>,
    report_service: std::sync::Arc<dyn TaskReportService + Sync + Send>,
    sub_task_services: HashMap<TaskDisplayType, std::sync::Arc<dyn SubTaskService + Sync + Send>>,
    max_tasks_count: u32,
    tasks_count: AtomicU32,
}

impl TaskSchedulerServiceImpl {
    pub fn new(
        repo: std::sync::Arc<dyn ITaskRepository + Sync + Send>,
        sub_repo: std::sync::Arc<dyn ISubTaskRepository + Sync + Send>,
        report_service: std::sync::Arc<dyn TaskReportService + Sync + Send>,
        sub_task_services: HashMap<
            TaskDisplayType,
            std::sync::Arc<dyn SubTaskService + Sync + Send>,
        >,
        max_tasks_count: u32,
    ) -> Self {
        Self {
            repo,
            sub_repo,
            report_service,
            sub_task_services,
            max_tasks_count,
            tasks_count: AtomicU32::new(0),
        }
    }
}

#[async_trait::async_trait]
impl TaskSchedulerService for TaskSchedulerServiceImpl {
    async fn enqueue_task(&self, task: &Task) -> anyhow::Result<()> {
        let mut task = task.clone();
        task.status = TaskStatus::Queuing;
        task.body = task
            .body
            .iter()
            .cloned()
            .map(|x| SubTask {
                status: TaskStatus::Queuing,
                ..x
            })
            .collect();
        self.repo.insert(task.clone()).await?;
        self.repo.save_changed().await?;
        self.schedule_next_task_by_id(task.id).await
    }

    async fn schedule_next_task(&self) -> anyhow::Result<()> {
        let id = self.repo.get_next_queuing_id().await?;
        match id {
            Some(id) => self.schedule_next_task_by_id(id).await,
            None => Ok(()),
        }
    }

    async fn schedule_next_task_by_id(&self, id: Uuid) -> anyhow::Result<()> {
        let task = self.repo.get_by_id(id.to_string().as_str()).await?;
        if task.status == TaskStatus::Queuing {
            let task = task.clone();
            self.repo
                .update(Task {
                    status: TaskStatus::Running,
                    ..task
                })
                .await?;
            self.repo.save_changed().await?;
        } else if task.status != TaskStatus::Running {
            anyhow::bail!("Unable to schedule a task not in task queue {}.", task.id);
        }
        self.report_service.report_started_task(&id.to_string()).await?;

        if task
            .body
            .iter()
            .any(|x| x.status == TaskStatus::Running || x.status == TaskStatus::Completing)
        {
            return Ok(());
        }

        let task_body = task
            .body
            .iter()
            .find(|x| x.status == TaskStatus::Queuing || x.status == TaskStatus::Suspended)
            .with_context(|| format!("There isn't queued task body in {}", task.id))?
            .clone();

        let task_count = self.tasks_count.load(std::sync::atomic::Ordering::Relaxed);
        if self.max_tasks_count != 0 && task_count == self.max_tasks_count {
            return Ok(());
        }
        self.tasks_count.store(task_count + 1, std::sync::atomic::Ordering::Relaxed);
        let task_type: TaskDisplayType = task_body.task_type.clone().into();
        let x = self
            .sub_task_services
            .get(&task_type)
            .with_context(|| format!("No such sub task service called {task_type}"))?;
        match task_body.status {
            TaskStatus::Queuing => {
                Ok(x.enqueue_sub_task(task_body.id.to_string().as_str()).await?)
            }
            TaskStatus::Suspended => {
                Ok(x.continue_sub_task(task_body.id.to_string().as_str()).await?)
            }
            _ => unreachable!(),
        }
    }

    async fn pause_task(&self, id: &str) -> anyhow::Result<()> {
        let task = self.repo.get_by_id(id).await?;
        match task.status.clone() {
            TaskStatus::Queuing => {
                for sub_task in task.body.iter() {
                    let task_type: TaskDisplayType = sub_task.task_type.clone().into();
                    if let Some(x) = self.sub_task_services.get(&task_type) {
                        x.pause_sub_task(sub_task.id.to_string().as_str()).await?
                    }
                }
                self.repo
                    .update(Task {
                        status: TaskStatus::Suspended,
                        ..task
                    })
                    .await?;
                self.report_service.report_paused_task(id).await?;
                self.repo.save_changed().await.map(|_| ())
            }
            TaskStatus::Running => {
                let task_count = self.tasks_count.load(std::sync::atomic::Ordering::Relaxed);
                self.tasks_count.store(task_count - 1, std::sync::atomic::Ordering::Relaxed);
                for sub_task in task.body.iter() {
                    let task_type: TaskDisplayType = sub_task.task_type.clone().into();
                    if let Some(x) = self.sub_task_services.get(&task_type) {
                        x.pause_sub_task(sub_task.id.to_string().as_str()).await?
                    }
                }
                self.repo
                    .update(Task {
                        status: TaskStatus::Suspended,
                        ..task
                    })
                    .await?;
                self.repo.save_changed().await?;
                self.report_service.report_paused_task(id).await?;
                self.schedule_next_task().await
            }
            _ => anyhow::bail!("Unable to pause task {id}."),
        }
    }

    async fn delete_task(&self, id: &str, is_internal: bool) -> anyhow::Result<()> {
        let task = self.repo.get_by_id(id).await?;
        if let TaskStatus::Running = task.status.clone() {
            let task_count = self.tasks_count.load(std::sync::atomic::Ordering::Relaxed);
            self.tasks_count.store(task_count - 1, std::sync::atomic::Ordering::Relaxed);
            let task = task.clone();
            for sub_task in task.body.iter() {
                let task_type: TaskDisplayType = sub_task.task_type.clone().into();
                if let Some(x) = self.sub_task_services.get(&task_type) {
                    x.pause_sub_task(sub_task.id.to_string().as_str()).await?
                }
            }
            self.repo
                .update(Task {
                    status: TaskStatus::Suspended,
                    ..task
                })
                .await?;
            self.repo.save_changed().await?;
            self.schedule_next_task().await?;
        }
        for sub_task in task.body.iter() {
            let task_type: TaskDisplayType = sub_task.task_type.clone().into();
            if let Some(x) = self.sub_task_services.get(&task_type) {
                x.delete_sub_task(sub_task.id.to_string().as_str()).await?
            }
        }
        self.repo.delete_by_id(id, None).await?;
        if !is_internal {
            self.report_service.report_deleted_task(id).await?;
        }
        self.repo.save_changed().await.map(|_| ())
    }

    async fn continue_task(&self, id: &str) -> anyhow::Result<()> {
        let task = self.repo.get_by_id(id).await?;
        let task_id = task.id;
        self.repo
            .update(Task {
                status: TaskStatus::Queuing,
                ..task
            })
            .await?;
        self.repo.save_changed().await?;
        self.report_service.report_resumed_task(id).await?;
        self.schedule_next_task_by_id(task_id).await
    }

    async fn complete_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let sub_task = self.sub_repo.get_by_id(id).await?;
        self.sub_repo
            .update(SubTask {
                status: TaskStatus::Completed,
                ..sub_task
            })
            .await?;
        self.sub_repo.save_changed().await?;
        let task_count = self.tasks_count.load(std::sync::atomic::Ordering::Relaxed);
        self.tasks_count.store(task_count - 1, std::sync::atomic::Ordering::Relaxed);
        let task = self.repo.get_by_id(sub_task.parent_id.to_string().as_str()).await?;
        if task.body.iter().all(|x| x.status == TaskStatus::Completed) {
            self.repo
                .update(Task {
                    status: TaskStatus::Completed,
                    ..task
                })
                .await?;
            self.repo.save_changed().await?;
            self.report_service
                .report_completed_task(sub_task.parent_id.to_string().as_str())
                .await?;
            return self.schedule_next_task().await;
        }
        self.schedule_next_task_by_id(sub_task.parent_id).await
    }

    async fn fail_sub_task(&self, id: &str) -> anyhow::Result<()> {
        let task_count = self.tasks_count.load(std::sync::atomic::Ordering::Relaxed);
        self.tasks_count.store(task_count - 1, std::sync::atomic::Ordering::Relaxed);
        let sub_task = self.sub_repo.get_by_id(id).await?;
        let task = self.repo.get_by_id(sub_task.parent_id.to_string().as_str()).await?;
        self.repo
            .update(Task {
                status: TaskStatus::Failed,
                ..task
            })
            .await?;
        self.repo.save_changed().await?;
        self.report_service
            .report_failed_task(
                sub_task.parent_id.to_string().as_str(),
                sub_task.failed_reason.as_str(),
            )
            .await?;
        self.schedule_next_task().await
    }

    async fn delete_all_completed_tasks(&self) -> anyhow::Result<()> {
        let tasks = self.repo.get_all().await?;
        for task in tasks.iter() {
            if task.status == TaskStatus::Completed
                && task.update_time > chrono::Utc::now() - chrono::Duration::hours(2)
            {
                self.delete_task(task.id.to_string().as_str(), true).await?;
            }
        }
        Ok(())
    }
}
