use domain::{
    model::vo::TaskDisplayType,
    service::{RunJobService, SubTaskService},
};
use mockall::mock;

mock! {
    pub RunTask {}

    #[async_trait::async_trait]
    impl RunJobService for RunTask {

        async fn run_job(&self, id: &str) -> anyhow::Result<()>;
        async fn complete_job(&self, id: &str) -> anyhow::Result<()>;
        async fn fail_job(&self, id: &str, reason: &str) -> anyhow::Result<()>;
    }

    #[async_trait::async_trait]
    impl SubTaskService for RunTask {
        async fn enqueue_sub_task(&self, id: &str) -> anyhow::Result<()>;
        async fn delete_sub_task(&self, id: &str) -> anyhow::Result<()>;
        async fn pause_sub_task(&self, id: &str) -> anyhow::Result<()>;
        async fn continue_sub_task(&self, id: &str) -> anyhow::Result<()>;
        async fn refresh_all_status(&self) -> anyhow::Result<()>;
        async fn refresh_status(&self, id: &str) -> anyhow::Result<()>;
        fn get_task_type(&self) -> TaskDisplayType {
            TaskDisplayType::Unknown
        }
    }
}
