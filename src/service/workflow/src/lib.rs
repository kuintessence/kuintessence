pub mod queue_resource;
pub mod schedule;
pub mod software_deployment;
pub mod status_receiver;
pub mod task_distribution;
pub mod use_cases;
#[allow(clippy::module_inception)]
pub mod workflow;

pub mod prelude {
    #[rustfmt::skip]
    pub use super::{
        queue_resource::QueueResourceServiceImpl,
        schedule::WorkflowScheduleServiceImpl,
        software_deployment::SoftwareDeploymentServiceImpl,
        status_receiver::WorkflowStatusReceiverServiceImpl,
        task_distribution::TaskDistributionServiceImpl,
        use_cases::prelude::*,
        workflow::WorkflowServiceImpl,
    };
}
