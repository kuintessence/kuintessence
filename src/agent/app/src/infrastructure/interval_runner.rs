use agent_core::services::{IRunJobService, ITaskSchedulerService};
use alice_architecture::hosting::IBackgroundService;
use std::time::Duration;
use tokio::time::interval;
use tracing::Instrument;

pub struct IntervalRunner {
    service: std::sync::Arc<dyn IRunJobService + Send + Sync>,
    scheduler: std::sync::Arc<dyn ITaskSchedulerService + Send + Sync>,
    interval: Duration,
}

#[async_trait::async_trait]
impl IBackgroundService for IntervalRunner {
    async fn run(&self) {
        let mut interval = interval(self.interval);
        loop {
            let service = self.service.clone();
            let scheduler = self.scheduler.clone();
            tokio::spawn(
                async move {
                    if let Err(e) = service.refresh_all_status().await {
                        log::error!("{}", e);
                    }
                    if let Err(e) = scheduler.delete_all_completed_tasks().await {
                        log::error!("{}", e);
                    }
                    if let Err(e) = scheduler.schedule_next_task().await {
                        log::error!("{}", e);
                    }
                }
                .instrument(tracing::trace_span!("interval_runner")),
            );
            interval.tick().await;
        }
    }
}

impl IntervalRunner {
    pub fn new(
        interval: u64,
        scheduler: std::sync::Arc<dyn ITaskSchedulerService + Send + Sync>,
        service: std::sync::Arc<dyn IRunJobService + Send + Sync>,
    ) -> Self {
        Self {
            interval: Duration::from_secs(interval),
            service,
            scheduler,
        }
    }
}
