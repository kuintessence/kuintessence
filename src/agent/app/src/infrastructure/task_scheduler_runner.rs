use agent_core::services::{ISubTaskReportService, ITaskSchedulerService};
use alice_architecture::hosting::IBackgroundService;
use std::sync::Arc;
use tracing::Instrument;

pub struct TaskSchedulerRunner {
    receiver: flume::Receiver<SubTaskReport>,
    scheduler_task: Arc<dyn ITaskSchedulerService + Send + Sync>,
}

#[async_trait::async_trait]
impl IBackgroundService for TaskSchedulerRunner {
    async fn run(&self) {
        loop {
            let scheduler_task = self.scheduler_task.clone();
            match self.receiver.recv_async().await {
                Ok(report) => {
                    tokio::spawn(
                        async move {
                            let report = report.clone();
                            let scheduler_task = scheduler_task.clone();
                            match report.status {
                                SubTaskStatus::Completed => {
                                    match scheduler_task.complete_sub_task(&report.id).await {
                                        Ok(()) => log::debug!(
                                            "Sub-task {} is reported to complete.",
                                            report.id
                                        ),
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                                SubTaskStatus::Failed => {
                                    match scheduler_task.fail_sub_task(&report.id).await {
                                        Ok(()) => log::debug!(
                                            "Sub-task {} is reported to fail.",
                                            report.id
                                        ),
                                        Err(e) => log::error!("{}", e),
                                    }
                                }
                            }
                        }
                        .instrument(tracing::trace_span!("task_scheduler_runner")),
                    );
                }
                Err(e) => log::error!("{}", e),
            }
        }
    }
}

impl TaskSchedulerRunner {
    pub fn new(
        receiver: flume::Receiver<SubTaskReport>,
        scheduler_task: Arc<dyn ITaskSchedulerService + Send + Sync>,
    ) -> Self {
        Self {
            receiver,
            scheduler_task,
        }
    }
}

#[derive(Clone)]
pub struct SubTaskReport {
    pub id: String,
    pub status: SubTaskStatus,
}

#[derive(Clone)]
pub enum SubTaskStatus {
    Completed,
    Failed,
}

pub struct SubTaskReportService {
    receiver: flume::Receiver<SubTaskReport>,
    sender: Arc<flume::Sender<SubTaskReport>>,
}

#[async_trait::async_trait]
impl ISubTaskReportService for SubTaskReportService {
    async fn report_completed_task(&self, id: &str) -> anyhow::Result<()> {
        Ok(self
            .sender
            .send_async(SubTaskReport {
                id: id.to_string(),
                status: SubTaskStatus::Completed,
            })
            .await?)
    }
    async fn report_failed_task(&self, id: &str) -> anyhow::Result<()> {
        Ok(self
            .sender
            .send_async(SubTaskReport {
                id: id.to_string(),
                status: SubTaskStatus::Failed,
            })
            .await?)
    }
}

impl SubTaskReportService {
    pub fn new() -> Self {
        let (sender, receiver): (flume::Sender<SubTaskReport>, flume::Receiver<SubTaskReport>) =
            flume::unbounded();
        Self {
            sender: Arc::from(sender),
            receiver,
        }
    }

    pub fn get_receiver(&self) -> flume::Receiver<SubTaskReport> {
        self.receiver.clone()
    }
}
