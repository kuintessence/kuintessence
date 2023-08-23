use crate::prelude::*;

/// 脚本用例解析微服务
pub struct ScriptUsecaseService {
    /// 任务分发服务
    task_distribution_service: Arc<dyn ITaskDistributionService + Send + Sync>,
    /// 集群仓储
    cluster_repository: Arc<dyn IClusterRepository + Send + Sync>,
    /// 节点实例仓储
    node_instance_repository: Arc<dyn INodeInstanceRepository + Send + Sync>,
}

impl ScriptUsecaseService {
    pub fn new(
        task_distribution_service: Arc<dyn ITaskDistributionService + Send + Sync>,
        cluster_repository: Arc<dyn IClusterRepository + Send + Sync>,
        node_instance_repository: Arc<dyn INodeInstanceRepository + Send + Sync>,
    ) -> Self {
        Self {
            task_distribution_service,
            cluster_repository,
            node_instance_repository,
        }
    }
}

#[async_trait]
impl IUsecaseService for ScriptUsecaseService {
    /// 处理用例
    /// 输入 节点信息
    /// 输出 Ok
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        let task = if let NodeKind::Script { script_info } = node_spec.kind {
            let mut task = Task {
                id: node_spec.id.to_owned(),
                command: TaskCommand::Start,
                body: vec![],
            };
            task.body.push(TaskBody::ExecuteScript { script_info });
            task
        } else {
            anyhow::bail!("Unreachable node kind.");
        };

        let cluster_id = self.cluster_repository.get_random_cluster().await?;
        let mut node_instance =
            self.node_instance_repository.get_by_id(&task.id.to_string()).await?;
        node_instance.cluster_id = Some(cluster_id);
        self.node_instance_repository.update(node_instance).await?;
        self.node_instance_repository.save_changed().await?;
        self.task_distribution_service.send_task(&task, cluster_id).await
    }

    /// 操作软件计算任务
    async fn operate_task(&self, operate: Operation) -> anyhow::Result<()> {
        let cluster_id = self
            .node_instance_repository
            .get_by_id(&operate.task_id.to_string())
            .await?
            .cluster_id
            .ok_or(anyhow::anyhow!("Node instance without cluster id!"))?;
        let command = operate.command;
        let task = Task {
            id: operate.task_id,
            body: vec![],
            command,
        };
        self.task_distribution_service.send_task(&task, cluster_id).await
    }
    fn get_service_type(&self) -> NodeInstanceKind {
        NodeInstanceKind::Script
    }
    async fn get_cmd(&self, _node_id: Uuid) -> anyhow::Result<Option<String>> {
        unimplemented!()
    }
}
