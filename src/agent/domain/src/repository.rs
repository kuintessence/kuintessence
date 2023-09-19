use alice_architecture::repository::IDBRepository;

use crate::model::entity::{file::FileStatus, File, SubTask, Task};

#[async_trait::async_trait]
pub trait IFileRepository: IDBRepository<File> {
    async fn find_files_by_task(&self, id: &str) -> anyhow::Result<Vec<File>>;
    async fn update_task_file_status(&self, id: &str, status: FileStatus) -> anyhow::Result<File>;
}

#[async_trait::async_trait]
pub trait ISubTaskRepository: IDBRepository<SubTask> {
    async fn get_all_refreshable_task(&self) -> anyhow::Result<Vec<SubTask>>;
}

#[async_trait::async_trait]
pub trait ITaskRepository: IDBRepository<Task> {
    async fn get_next_queuing_id(&self) -> anyhow::Result<Option<uuid::Uuid>>;
}
