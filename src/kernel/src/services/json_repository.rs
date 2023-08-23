use crate::prelude::*;
use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use std::{str::FromStr, sync::Arc};
use tokio::sync::Mutex;

pub struct JSONRepository {
    workflow_drafts: Arc<Mutex<Vec<WorkflowDraft>>>,
    workflow_instances: Arc<Mutex<Vec<WorkflowInstance>>>,
    node_instances: Arc<Mutex<Vec<NodeInstance>>>,
    file_metadatas: Arc<Mutex<Vec<FileMeta>>>,
    clusters: Arc<Mutex<Vec<Cluster>>>,
    save_dir: String,
}
#[async_trait]
impl IReadOnlyRepository<Cluster> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<Cluster> {
        let clusters = self.clusters.lock().await;
        let cluster = clusters
            .iter()
            .find(|x| x.id.eq(uuid))
            .ok_or(anyhow::anyhow!("No Such file metadata id."))?;
        Ok(cluster.clone())
    }
    async fn get_all(&self) -> anyhow::Result<Vec<Cluster>> {
        Ok(self.clusters.lock().await.clone())
    }
}

#[async_trait]
impl IReadOnlyRepository<FileMeta> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<FileMeta> {
        let file_metadatas = self.file_metadatas.lock().await;
        let file_metadata = file_metadatas
            .iter()
            .find(|x| x.id.eq(&Uuid::from_str(uuid).unwrap()))
            .ok_or(anyhow::anyhow!("No Such file metadata id."))?;
        Ok(file_metadata.clone())
    }
    async fn get_all(&self) -> anyhow::Result<Vec<FileMeta>> {
        Ok(self.file_metadatas.lock().await.clone())
    }
}

#[async_trait]
impl IReadOnlyRepository<WorkflowDraft> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WorkflowDraft> {
        let workflow_drafts = self.workflow_drafts.lock().await;
        let workflow_draft = workflow_drafts
            .iter()
            .find(|x| x.id.eq(&Uuid::from_str(uuid).unwrap()))
            .ok_or(anyhow::anyhow!("No Such workflow draft id."))?;
        Ok(workflow_draft.clone())
    }
    async fn get_all(&self) -> anyhow::Result<Vec<WorkflowDraft>> {
        Ok(self.workflow_drafts.lock().await.clone())
    }
}

#[async_trait]
impl IReadOnlyRepository<WorkflowInstance> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WorkflowInstance> {
        let workflow_instances = self.workflow_instances.lock().await;
        let workflow_instance = workflow_instances
            .iter()
            .find(|x| x.id.eq(&Uuid::from_str(uuid).unwrap()))
            .ok_or(anyhow::anyhow!("No Such workflow instance id."))?;
        Ok(workflow_instance.clone())
    }
    async fn get_all(&self) -> anyhow::Result<Vec<WorkflowInstance>> {
        Ok(self.workflow_instances.lock().await.clone())
    }
}

#[async_trait]
impl IReadOnlyRepository<NodeInstance> for JSONRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<NodeInstance> {
        let node_instances = self.node_instances.lock().await;
        let node_instance = node_instances
            .iter()
            .find(|x| x.id.eq(&Uuid::from_str(uuid).unwrap()))
            .ok_or(anyhow::anyhow!("No Such workflow instance id."))?;
        Ok(node_instance.clone())
    }
    async fn get_all(&self) -> anyhow::Result<Vec<NodeInstance>> {
        Ok(self.node_instances.lock().await.clone())
    }
}

/// 可变仓储，对修改数据的仓储进行抽象
#[async_trait]
impl IMutableRepository<WorkflowDraft> for JSONRepository {
    /// 更新数据
    async fn update(&self, entity: WorkflowDraft) -> anyhow::Result<WorkflowDraft> {
        let mut workflow_drafts = self.workflow_drafts.lock().await;
        *workflow_drafts
            .iter_mut()
            .find(|el| el.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))? = entity.clone();
        Ok(entity)
    }
    /// 插入数据
    async fn insert(&self, entity: WorkflowDraft) -> anyhow::Result<WorkflowDraft> {
        let mut workflow_drafts = self.workflow_drafts.lock().await;
        if let Some(x) = workflow_drafts.iter().position(|x| x.id == entity.id) {
            workflow_drafts.remove(x);
        }
        workflow_drafts.push(entity.clone());
        Ok(entity)
    }
    /// 删除数据
    async fn delete(&self, entity: WorkflowDraft) -> anyhow::Result<bool> {
        let mut workflow_drafts = self.workflow_drafts.lock().await;
        let index = workflow_drafts
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        workflow_drafts.remove(index);
        Ok(true)
    }
    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(
        &self,
        uuid: &str,
        _entity: Option<WorkflowDraft>,
    ) -> anyhow::Result<bool> {
        let mut workflow_drafts = self.workflow_drafts.lock().await;
        let index = workflow_drafts
            .iter()
            .position(|x| x.id.eq(&Uuid::from_str(uuid).unwrap()))
            .ok_or(anyhow::anyhow!("No Such id"))?;
        workflow_drafts.remove(index);
        Ok(true)
    }
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool> {
        let mut workflow_drafts_path = std::path::PathBuf::new();
        let mut workflow_instances_path = std::path::PathBuf::new();
        let mut node_instances_path = std::path::PathBuf::new();
        let mut file_metadatas_path = std::path::PathBuf::new();
        workflow_drafts_path.push(self.save_dir.as_str());
        workflow_drafts_path.push("workflow_drafts.json");
        workflow_instances_path.push(self.save_dir.as_str());
        workflow_instances_path.push("workflow_instances.json");
        node_instances_path.push(self.save_dir.as_str());
        node_instances_path.push("node_instances.json");
        file_metadatas_path.push(self.save_dir.as_str());
        file_metadatas_path.push("file_metadatas.json");
        let workflow_drafts = self.workflow_drafts.lock().await;
        let workflow_instances = self.workflow_instances.lock().await;
        let node_instances = self.node_instances.lock().await;
        let file_metadatas = self.file_metadatas.lock().await;
        let workflow_drafts_json = serde_json::to_string_pretty(&workflow_drafts.clone())?;
        let workflow_instances_json = serde_json::to_string_pretty(&workflow_instances.clone())?;
        let node_instances_json = serde_json::to_string_pretty(&node_instances.clone())?;
        let file_metadatas_json = serde_json::to_string_pretty(&file_metadatas.clone())?;
        tokio::fs::write(workflow_drafts_path, workflow_drafts_json).await?;
        tokio::fs::write(workflow_instances_path, workflow_instances_json).await?;
        tokio::fs::write(node_instances_path, node_instances_json).await?;
        tokio::fs::write(file_metadatas_path, file_metadatas_json).await?;
        Ok(true)
    }
}

/// 可变仓储，对修改数据的仓储进行抽象
#[async_trait]
impl IMutableRepository<WorkflowInstance> for JSONRepository {
    /// 更新数据
    async fn update(&self, entity: WorkflowInstance) -> anyhow::Result<WorkflowInstance> {
        let mut workflow_instances = self.workflow_instances.lock().await;
        let index = workflow_instances
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        workflow_instances.remove(index);
        workflow_instances.push(entity.clone());
        Ok(entity)
    }
    /// 插入数据
    async fn insert(&self, entity: WorkflowInstance) -> anyhow::Result<WorkflowInstance> {
        let mut workflow_instances = self.workflow_instances.lock().await;
        if let Some(x) = workflow_instances.iter().position(|x| x.id == entity.id) {
            workflow_instances.remove(x);
        }
        workflow_instances.push(entity.clone());
        Ok(entity)
    }
    /// 删除数据
    async fn delete(&self, entity: WorkflowInstance) -> anyhow::Result<bool> {
        let mut workflow_instances = self.workflow_instances.lock().await;
        let index = workflow_instances
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        workflow_instances.remove(index);
        Ok(true)
    }
    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(
        &self,
        uuid: &str,
        _entity: Option<WorkflowInstance>,
    ) -> anyhow::Result<bool> {
        let mut workflow_instances = self.workflow_instances.lock().await;
        let index = workflow_instances
            .iter()
            .position(|x| x.id.eq(&Uuid::from_str(uuid).unwrap()))
            .ok_or(anyhow::anyhow!("No Such id"))?;
        workflow_instances.remove(index);
        Ok(true)
    }
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool> {
        let mut workflow_drafts_path = std::path::PathBuf::new();
        let mut workflow_instances_path = std::path::PathBuf::new();
        let mut node_instances_path = std::path::PathBuf::new();
        let mut file_metadatas_path = std::path::PathBuf::new();
        workflow_drafts_path.push(self.save_dir.as_str());
        workflow_drafts_path.push("workflow_drafts.json");
        workflow_instances_path.push(self.save_dir.as_str());
        workflow_instances_path.push("workflow_instances.json");
        node_instances_path.push(self.save_dir.as_str());
        node_instances_path.push("node_instances.json");
        file_metadatas_path.push(self.save_dir.as_str());
        file_metadatas_path.push("file_metadatas.json");
        let workflow_drafts = self.workflow_drafts.lock().await;
        let workflow_instances = self.workflow_instances.lock().await;
        let node_instances = self.node_instances.lock().await;
        let file_metadatas = self.file_metadatas.lock().await;
        let workflow_drafts_json = serde_json::to_string_pretty(&workflow_drafts.clone())?;
        let workflow_instances_json = serde_json::to_string_pretty(&workflow_instances.clone())?;
        let node_instances_json = serde_json::to_string_pretty(&node_instances.clone())?;
        let file_metadatas_json = serde_json::to_string_pretty(&file_metadatas.clone())?;
        tokio::fs::write(workflow_drafts_path, workflow_drafts_json).await?;
        tokio::fs::write(workflow_instances_path, workflow_instances_json).await?;
        tokio::fs::write(node_instances_path, node_instances_json).await?;
        tokio::fs::write(file_metadatas_path, file_metadatas_json).await?;
        Ok(true)
    }
}

/// 可变仓储，对修改数据的仓储进行抽象
#[async_trait]
impl IMutableRepository<NodeInstance> for JSONRepository {
    /// 更新数据
    async fn update(&self, entity: NodeInstance) -> anyhow::Result<NodeInstance> {
        let mut node_instances = self.node_instances.lock().await;
        *node_instances
            .iter_mut()
            .find(|el| el.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))? = entity.clone();
        Ok(entity)
    }
    /// 插入数据
    async fn insert(&self, entity: NodeInstance) -> anyhow::Result<NodeInstance> {
        let mut node_instances = self.node_instances.lock().await;
        if let Some(x) = node_instances.iter().position(|x| x.id == entity.id) {
            node_instances.remove(x);
        }
        node_instances.push(entity.clone());
        Ok(entity)
    }
    /// 删除数据
    async fn delete(&self, entity: NodeInstance) -> anyhow::Result<bool> {
        let mut node_instances = self.node_instances.lock().await;
        let index = node_instances
            .iter()
            .position(|x| x.id == entity.id)
            .ok_or(anyhow::anyhow!("No Such id"))?;
        node_instances.remove(index);
        Ok(true)
    }
    /// 使用 uuid 删除数据，`entity` 是用于指示当前实现类型的泛型模板，防止 Rust 产生方法重载的问题，
    /// 但对于大多数数据库可尝试使用以下代码：
    /// ``` no_run
    /// // 建立一个空的枚举用于指示类型
    /// let n: Option<TYPE> = None;
    /// self.delete_by_id(entity.id.as_str(), n).await?;
    /// ```
    async fn delete_by_id(
        &self,
        uuid: &str,
        _entity: Option<NodeInstance>,
    ) -> anyhow::Result<bool> {
        let mut node_instances = self.node_instances.lock().await;
        let index = node_instances
            .iter()
            .position(|x| x.id.eq(&Uuid::from_str(uuid).unwrap()))
            .ok_or(anyhow::anyhow!("No Such id"))?;
        node_instances.remove(index);
        Ok(true)
    }
    /// 提交变更，在带有事务的数据库将提交事务，否则该方法应该仅返回 `Ok(true)`
    ///
    async fn save_changed(&self) -> anyhow::Result<bool> {
        let mut workflow_drafts_path = std::path::PathBuf::new();
        let mut workflow_instances_path = std::path::PathBuf::new();
        let mut node_instances_path = std::path::PathBuf::new();
        let mut file_metadatas_path = std::path::PathBuf::new();
        workflow_drafts_path.push(self.save_dir.as_str());
        workflow_drafts_path.push("workflow_drafts.json");
        workflow_instances_path.push(self.save_dir.as_str());
        workflow_instances_path.push("workflow_instances.json");
        node_instances_path.push(self.save_dir.as_str());
        node_instances_path.push("node_instances.json");
        file_metadatas_path.push(self.save_dir.as_str());
        file_metadatas_path.push("file_metadatas.json");
        let workflow_drafts = self.workflow_drafts.lock().await;
        let workflow_instances = self.workflow_instances.lock().await;
        let node_instances = self.node_instances.lock().await;
        let file_metadatas = self.file_metadatas.lock().await;
        let workflow_drafts_json = serde_json::to_string_pretty(&workflow_drafts.clone())?;
        let workflow_instances_json = serde_json::to_string_pretty(&workflow_instances.clone())?;
        let node_instances_json = serde_json::to_string_pretty(&node_instances.clone())?;
        let file_metadatas_json = serde_json::to_string_pretty(&file_metadatas.clone())?;
        tokio::fs::write(workflow_drafts_path, workflow_drafts_json).await?;
        tokio::fs::write(workflow_instances_path, workflow_instances_json).await?;
        tokio::fs::write(node_instances_path, node_instances_json).await?;
        tokio::fs::write(file_metadatas_path, file_metadatas_json).await?;
        Ok(true)
    }
}

impl IDBRepository<WorkflowDraft> for JSONRepository {}
impl IDBRepository<WorkflowInstance> for JSONRepository {}
impl IDBRepository<NodeInstance> for JSONRepository {}

#[async_trait]
impl INodeInstanceRepository for JSONRepository {
    async fn get_node_sub_node_instances(
        &self,
        batch_parent_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>> {
        let node_instances = self.node_instances.lock().await;
        let sub_nodes = node_instances
            .clone()
            .into_iter()
            .filter(|el| {
                el.batch_parent_id.is_some()
                    && el.batch_parent_id.as_ref().unwrap().eq(&batch_parent_id)
            })
            .collect::<Vec<_>>();
        Ok(sub_nodes)
    }

    async fn is_all_same_entryment_nodes_success(&self, node_id: Uuid) -> anyhow::Result<bool> {
        let node_instances = self.node_instances.lock().await;
        let flow_instance_id = node_instances
            .iter()
            .find(|el| el.id.eq(&node_id))
            .ok_or(anyhow::anyhow!("No such node!"))?
            .flow_instance_id
            .to_owned();
        Ok(node_instances
            .iter()
            .filter(|el| el.flow_instance_id.eq(&flow_instance_id) && el.batch_parent_id.is_none())
            .all(|el| {
                el.status.eq(&NodeInstanceStatus::Finished)
                    || el.status.eq(&NodeInstanceStatus::Standby)
            }))
    }

    async fn get_all_workflow_instance_stand_by_nodes(
        &self,
        workflow_instance_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>> {
        let node_instances = self.node_instances.lock().await;
        Ok(node_instances
            .clone()
            .into_iter()
            .filter(|el| {
                el.flow_instance_id.eq(&workflow_instance_id)
                    && el.status.eq(&NodeInstanceStatus::Standby)
            })
            .collect::<Vec<_>>())
    }

    async fn get_all_workflow_instance_nodes(
        &self,
        workflow_instance_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>> {
        let node_instances = self.node_instances.lock().await;
        Ok(node_instances
            .clone()
            .into_iter()
            .filter(|el| el.flow_instance_id.eq(&workflow_instance_id))
            .collect::<Vec<_>>())
    }

    async fn get_nth_of_batch_tasks(&self, sub_node_id: Uuid) -> anyhow::Result<usize> {
        let node_instances = self.node_instances.lock().await;
        let batch_parent_id = node_instances
            .iter()
            .find(|el| el.id.eq(&sub_node_id))
            .ok_or(anyhow::anyhow!("No such sub node!"))?
            .batch_parent_id
            .to_owned();
        let sub_nodes = node_instances
            .iter()
            .filter(|el| el.batch_parent_id.eq(&batch_parent_id))
            .collect::<Vec<_>>();
        Ok(sub_nodes
            .iter()
            .position(|el| el.id.eq(&sub_node_id))
            .ok_or(anyhow::anyhow!("No such sub node!"))?)
    }
}

#[async_trait]
impl IWorkflowInstanceRepository for JSONRepository {
    /// 根据节点 id 获取工作流实例
    async fn get_by_node_id(&self, node_id: Uuid) -> anyhow::Result<WorkflowInstance> {
        let node_instances = self.node_instances.lock().await;
        let workflow_instances = self.workflow_instances.lock().await;
        let flow_instance_id = node_instances
            .iter()
            .find(|el| el.id.eq(&node_id))
            .ok_or(anyhow::anyhow!(
                "No such workflow contains node_id:{node_id}"
            ))?
            .flow_instance_id
            .to_owned();
        let workflow_instance = workflow_instances
            .iter()
            .find(|el| el.id.eq(&flow_instance_id))
            .ok_or(anyhow::anyhow!("No such workflow id:{flow_instance_id}"))?;
        Ok(workflow_instance.to_owned())
    }

    async fn update_node_instance_prepared_file_ids(
        &self,
        old_id: Uuid,
        new_id: Uuid,
        node_instance_id: Uuid,
    ) -> Anyhow {
        let flow_instance = self.get_by_node_id(node_instance_id).await?;
        let x = serde_json::to_string(&flow_instance)?;
        let x = x.replace(&old_id.to_string(), &new_id.to_string());
        let flow_instance = serde_json::from_str::<WorkflowInstance>(&x)?;

        let mut workflow_instances = self.workflow_instances.lock().await;
        *workflow_instances
            .iter_mut()
            .find(|el| el.id.eq(&flow_instance.id))
            .ok_or(anyhow!("No such id."))? = flow_instance.to_owned();
        Ok(())
    }
}

impl JSONRepository {
    pub async fn new(save_dir: &str) -> anyhow::Result<Self> {
        let mut clusters_path = std::path::PathBuf::new();
        let mut workflow_dratfs_path = std::path::PathBuf::new();
        let mut workflow_instances_path = std::path::PathBuf::new();
        let mut node_instances_path = std::path::PathBuf::new();
        let mut file_metadatas_path = std::path::PathBuf::new();
        clusters_path.push(save_dir);
        workflow_dratfs_path.push(save_dir);
        workflow_dratfs_path.push("workflow_drafts.json");
        workflow_instances_path.push(save_dir);
        workflow_instances_path.push("workflow_instances.json");
        node_instances_path.push(save_dir);
        node_instances_path.push("node_instances.json");
        file_metadatas_path.push(save_dir);
        file_metadatas_path.push("file_metadatas.json");

        let clusters: Vec<Cluster> = match clusters_path.exists() && clusters_path.is_file() {
            true => match tokio::fs::read(clusters_path).await {
                Ok(x) => {
                    if !x.is_empty() {
                        serde_json::from_slice(&x)?
                    } else {
                        vec![]
                    }
                }
                Err(_) => vec![],
            },
            false => vec![],
        };
        let workflow_drafts: Vec<WorkflowDraft> =
            match workflow_dratfs_path.exists() && workflow_dratfs_path.is_file() {
                true => match tokio::fs::read(workflow_dratfs_path).await {
                    Ok(x) => {
                        if !x.is_empty() {
                            serde_json::from_slice(&x)?
                        } else {
                            vec![]
                        }
                    }
                    Err(_) => vec![],
                },
                false => vec![],
            };
        let workflow_instances: Vec<WorkflowInstance> =
            match workflow_instances_path.exists() && workflow_instances_path.is_file() {
                true => match tokio::fs::read(workflow_instances_path).await {
                    Ok(x) => {
                        if !x.is_empty() {
                            serde_json::from_slice(&x)?
                        } else {
                            vec![]
                        }
                    }
                    Err(_) => vec![],
                },
                false => vec![],
            };
        let node_instances: Vec<NodeInstance> =
            match node_instances_path.exists() && node_instances_path.is_file() {
                true => match tokio::fs::read(node_instances_path).await {
                    Ok(x) => {
                        if !x.is_empty() {
                            serde_json::from_slice(&x)?
                        } else {
                            vec![]
                        }
                    }
                    Err(_) => vec![],
                },
                false => vec![],
            };
        let file_metadatas: Vec<FileMeta> =
            match file_metadatas_path.exists() && file_metadatas_path.is_file() {
                true => match tokio::fs::read(file_metadatas_path).await {
                    Ok(x) => {
                        if !x.is_empty() {
                            serde_json::from_slice(&x)?
                        } else {
                            vec![]
                        }
                    }
                    Err(_) => vec![],
                },
                false => vec![],
            };
        Ok(Self {
            clusters: Arc::new(Mutex::new(clusters)),
            workflow_drafts: Arc::new(Mutex::new(workflow_drafts)),
            workflow_instances: Arc::new(Mutex::new(workflow_instances)),
            node_instances: Arc::new(Mutex::new(node_instances)),
            save_dir: save_dir.to_string(),
            file_metadatas: Arc::new(Mutex::new(file_metadatas)),
        })
    }
}
