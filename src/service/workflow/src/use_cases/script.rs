use std::sync::Arc;

use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{
            node_instance::NodeInstanceKind,
            task::{TaskBody, TaskCommand},
            workflow_instance::NodeSpec,
            Task,
        },
        vo::{usecase::Operation, NodeKind},
    },
    repository::NodeInstanceRepo,
    service::{QueueResourceService, TaskDistributionService, UsecaseService},
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

/// 脚本用例解析微服务
#[derive(TypedBuilder)]
pub struct ScriptUsecaseServiceImpl {
    /// 任务分发服务
    task_distribution_service: Arc<dyn TaskDistributionService>,
    /// 队列资源服务
    queue_resource_service: Arc<dyn QueueResourceService>,
    /// 节点实例仓储
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
}

#[async_trait]
impl UsecaseService for ScriptUsecaseServiceImpl {
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

        let queue_id = self.queue_resource_service.get_queue(node_spec.id).await?.id;
        let mut node_instance =
            self.node_instance_repository.get_by_id(&task.id.to_string()).await?;
        node_instance.queue_id = Some(queue_id);
        self.node_instance_repository.update(node_instance).await?;
        self.node_instance_repository.save_changed().await?;
        self.task_distribution_service.send_task(&task, queue_id).await
    }

    /// 操作软件计算任务
    async fn operate_task(&self, operate: Operation) -> anyhow::Result<()> {
        let queue_id = self
            .node_instance_repository
            .get_by_id(&operate.task_id.to_string())
            .await?
            .queue_id
            .ok_or(anyhow::anyhow!("Node instance without cluster id!"))?;
        let command = operate.command;
        let task = Task {
            id: operate.task_id,
            body: vec![],
            command,
        };
        self.task_distribution_service.send_task(&task, queue_id).await
    }

    fn get_service_type(&self) -> NodeInstanceKind {
        NodeInstanceKind::Script
    }

    async fn get_cmd(&self, _node_id: Uuid) -> anyhow::Result<Option<String>> {
        unimplemented!()
    }
}
