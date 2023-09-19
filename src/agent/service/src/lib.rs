pub mod collection_task;
pub mod deploy_software;
pub mod run_job;
pub mod task_scheduler;

pub mod prelude {
    #[rustfmt::skip]
    pub use super::{
        collection_task::CollectionTaskServiceImpl,
        deploy_software::DeploySoftwareServiceImpl,
        run_job::RunJobServiceImpl,
        task_scheduler::TaskSchedulerServiceImpl,
    };
}
