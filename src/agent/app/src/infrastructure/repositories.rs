use agent_core::{
    models::{File, FileStatus, FileType, SubTask, Task, TaskStatus},
    repository::{IFileRepository, ISubTaskRepository, ITaskRepository},
};
use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct JSONRepository {
    tasks: Arc<Mutex<Vec<Task>>>,
    sub_tasks: Arc<Mutex<Vec<SubTask>>>,
    task_files: Arc<Mutex<Vec<File>>>,
    save_dir: String,
}

#[async_trait::async_trait]
impl IReadOnlyRepository<Task> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<Task> {
        let id = uuid::Uuid::parse_str(uuid)?;
        let tasks = self.tasks.lock().await;
        let sub_tasks = self.sub_tasks.lock().await;
        let task = tasks
            .iter()
            .find(|x| x.id == id)
            .ok_or(anyhow::anyhow!("No such task id."))?
            .clone();
        let body = sub_tasks.iter().cloned().filter(|x| x.parent_id == id).collect();
        Ok(Task { body, ..task })
    }
    async fn get_all(&self) -> anyhow::Result<Vec<Task>> {
        Ok(self.tasks.lock().await.clone())
    }
}

#[async_trait::async_trait]
impl IReadOnlyRepository<File> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<File> {
        let id = uuid::Uuid::parse_str(uuid)?;
        let task_files = self.task_files.lock().await;
        let task_file = task_files
            .iter()
            .find(|x| x.id == id)
            .ok_or(anyhow::anyhow!("No Such job id."))?;
        Ok(task_file.clone())
    }
    async fn get_all(&self) -> anyhow::Result<Vec<File>> {
        Ok(self.task_files.lock().await.clone())
    }
}

#[async_trait::async_trait]
impl IReadOnlyRepository<SubTask> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<SubTask> {
        let id = uuid::Uuid::parse_str(uuid)?;
        let sub_tasks = self.sub_tasks.lock().await;
        let sub_task = sub_tasks
            .iter()
            .find(|x| x.id == id)
            .ok_or(anyhow::anyhow!("No such task id."))?;
        Ok(sub_task.clone())
    }
    async fn get_all(&self) -> anyhow::Result<Vec<SubTask>> {
        Ok(self.sub_tasks.lock().await.clone())
    }
}

/// 可变仓储，对修改数据的仓储进行抽象
#[async_trait::async_trait]
impl IMutableRepository<Task> for JSONRepository {
    /// 更新数据
    async fn update(&self, entity: Task) -> anyhow::Result<Task> {
        let mut tasks = self.tasks.lock().await;
        let index = tasks
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        tasks.remove(index);
        tasks.push(Task {
            update_time: chrono::Utc::now(),
            ..entity.clone()
        });
        Ok(entity)
    }
    /// 插入数据
    async fn insert(&self, entity: Task) -> anyhow::Result<Task> {
        let mut tasks = self.tasks.lock().await;
        if let Some(x) = tasks.iter().position(|x| x.id == entity.id) {
            tasks.remove(x);
        }
        for sub_task in entity.body.iter() {
            self.insert(sub_task.clone()).await?;
        }
        tasks.push(entity.clone());
        Ok(entity)
    }
    /// 删除数据
    async fn delete(&self, entity: Task) -> anyhow::Result<bool> {
        let mut tasks = self.tasks.lock().await;
        let index = tasks
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        tasks.remove(index);
        Ok(true)
    }
    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(&self, uuid: &str, _entity: Option<Task>) -> anyhow::Result<bool> {
        let id = uuid::Uuid::parse_str(uuid)?;
        let mut tasks = self.tasks.lock().await;
        let index = tasks.iter().position(|x| x.id == id).ok_or(anyhow::anyhow!("No Such id"))?;
        tasks.remove(index);
        Ok(true)
    }
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait::async_trait]
impl IMutableRepository<SubTask> for JSONRepository {
    /// 更新数据
    async fn update(&self, entity: SubTask) -> anyhow::Result<SubTask> {
        let mut sub_tasks = self.sub_tasks.lock().await;
        let index = sub_tasks
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        sub_tasks.remove(index);
        sub_tasks.push(entity.clone());
        Ok(entity)
    }
    /// 插入数据
    async fn insert(&self, entity: SubTask) -> anyhow::Result<SubTask> {
        let mut sub_tasks = self.sub_tasks.lock().await;
        if let Some(x) = sub_tasks.iter().position(|x| x.id == entity.id) {
            sub_tasks.remove(x);
        }
        if let agent_core::models::TaskType::UsecaseExecution { files, .. } =
            entity.task_type.clone()
        {
            for file in files {
                self.insert(File {
                    id: file.id,
                    file_name: file.path.clone(),
                    related_task_body: entity.id,
                    file_type: file.file_type.clone(),
                    status: match file.file_type {
                        FileType::IN => FileStatus::RemoteOnly,
                        FileType::OUT => FileStatus::WaittingCreate,
                    },
                    is_optional: file.optional,
                    is_packaged: file.is_package,
                    is_generated: file.is_generated,
                    text: file.text,
                    metadata_id: file.metadata_id,
                })
                .await?;
            }
        }
        sub_tasks.push(entity.clone());
        Ok(entity)
    }
    /// 删除数据
    async fn delete(&self, entity: SubTask) -> anyhow::Result<bool> {
        let mut sub_tasks = self.sub_tasks.lock().await;
        let index = sub_tasks
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        sub_tasks.remove(index);
        Ok(true)
    }
    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(&self, uuid: &str, _entity: Option<SubTask>) -> anyhow::Result<bool> {
        let id = uuid::Uuid::parse_str(uuid)?;
        let mut sub_tasks = self.sub_tasks.lock().await;
        let index =
            sub_tasks.iter().position(|x| x.id == id).ok_or(anyhow::anyhow!("No Such id"))?;
        sub_tasks.remove(index);
        Ok(true)
    }
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

/// 可变仓储，对修改数据的仓储进行抽象
#[async_trait::async_trait]
impl IMutableRepository<File> for JSONRepository {
    /// 更新数据
    async fn update(&self, entity: File) -> anyhow::Result<File> {
        let mut task_files = self.task_files.lock().await;
        let index = task_files
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        task_files.remove(index);
        task_files.push(entity.clone());
        Ok(entity)
    }
    /// 插入数据
    async fn insert(&self, entity: File) -> anyhow::Result<File> {
        let mut task_files = self.task_files.lock().await;
        if let Some(x) = task_files.iter().position(|x| x.id == entity.id) {
            task_files.remove(x);
        }
        task_files.push(entity.clone());
        Ok(entity)
    }
    /// 删除数据
    async fn delete(&self, entity: File) -> anyhow::Result<bool> {
        let mut task_files = self.task_files.lock().await;
        let index = task_files
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        task_files.remove(index);
        Ok(true)
    }
    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(&self, uuid: &str, _entity: Option<File>) -> anyhow::Result<bool> {
        let id = uuid::Uuid::parse_str(uuid)?;
        let mut task_files = self.task_files.lock().await;
        let index = task_files
            .iter()
            .position(|x| x.id == id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        task_files.remove(index);
        Ok(true)
    }
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

impl IDBRepository<Task> for JSONRepository {}

impl IDBRepository<File> for JSONRepository {}

#[async_trait::async_trait]
impl IFileRepository for JSONRepository {
    async fn find_files_by_task(&self, id: &str) -> anyhow::Result<Vec<File>> {
        let id = uuid::Uuid::parse_str(id)?;
        let task_files = self.task_files.lock().await;
        let task_file = task_files.iter().filter(|&x| x.related_task_body == id);
        Ok(task_file.cloned().collect())
    }
    async fn update_task_file_status(&self, id: &str, status: FileStatus) -> anyhow::Result<File> {
        let mut file: File = self.get_by_id(id).await?;
        file.status = status;
        self.update(file.clone()).await?;
        Ok(file)
    }
}

impl IDBRepository<SubTask> for JSONRepository {}

#[async_trait::async_trait]
impl ISubTaskRepository for JSONRepository {
    async fn get_all_refreshable_task(&self) -> anyhow::Result<Vec<SubTask>> {
        Ok(self
            .sub_tasks
            .lock()
            .await
            .iter()
            .filter(|x| x.job_id != String::default() && x.status == TaskStatus::Running)
            .cloned()
            .collect())
    }
}

#[async_trait::async_trait]
impl ITaskRepository for JSONRepository {
    async fn get_next_queuing_id(&self) -> anyhow::Result<Option<uuid::Uuid>> {
        Ok(self
            .tasks
            .lock()
            .await
            .iter()
            .find(|x| x.status == TaskStatus::Queuing)
            .map(|x| x.id))
    }
}

impl JSONRepository {
    pub async fn new(save_dir: &str) -> anyhow::Result<Self> {
        let mut tasks_path = std::path::PathBuf::new();
        let mut sub_tasks_path = std::path::PathBuf::new();
        let mut task_files_path = std::path::PathBuf::new();
        tasks_path.push(save_dir);
        tasks_path.push("./tasks.json");
        sub_tasks_path.push(save_dir);
        sub_tasks_path.push("./sub_tasks.json");
        task_files_path.push(save_dir);
        task_files_path.push("task_files.json");
        let tasks: Vec<Task> = match tasks_path.exists() && tasks_path.is_file() {
            true => match tokio::fs::read(tasks_path).await {
                Ok(x) => serde_json::from_slice(&x)?,
                Err(_) => vec![],
            },
            false => vec![],
        };
        let sub_tasks: Vec<SubTask> = match sub_tasks_path.exists() && sub_tasks_path.is_file() {
            true => match tokio::fs::read(sub_tasks_path).await {
                Ok(x) => serde_json::from_slice(&x)?,
                Err(_) => vec![],
            },
            false => vec![],
        };
        let task_files: Vec<File> = match task_files_path.exists() && task_files_path.is_file() {
            true => match tokio::fs::read(task_files_path).await {
                Ok(x) => serde_json::from_slice(&x)?,
                Err(_) => vec![],
            },
            false => vec![],
        };
        Ok(Self {
            task_files: Arc::new(Mutex::new(task_files)),
            tasks: Arc::new(Mutex::new(tasks)),
            sub_tasks: Arc::new(Mutex::new(sub_tasks)),
            save_dir: save_dir.to_string(),
        })
    }
    async fn save_changed(&self) -> anyhow::Result<bool> {
        let mut tasks_path = std::path::PathBuf::new();
        let mut sub_tasks_path = std::path::PathBuf::new();
        let mut task_files_path = std::path::PathBuf::new();
        tasks_path.push(self.save_dir.as_str());
        tasks_path.push("./tasks.json");
        sub_tasks_path.push(self.save_dir.as_str());
        sub_tasks_path.push("./sub_tasks.json");
        task_files_path.push(self.save_dir.as_str());
        task_files_path.push("task_files.json");
        let tasks = self.tasks.lock().await;
        let sub_tasks = self.sub_tasks.lock().await;
        let task_files = self.task_files.lock().await;
        let tasks_json = serde_json::to_vec(&tasks.clone())?;
        let sub_tasks_json = serde_json::to_vec(&sub_tasks.clone())?;
        let task_files_json = serde_json::to_vec(&task_files.clone())?;
        tokio::fs::write(tasks_path, tasks_json).await?;
        tokio::fs::write(sub_tasks_path, sub_tasks_json).await?;
        tokio::fs::write(task_files_path, task_files_json).await?;
        Ok(true)
    }
}
