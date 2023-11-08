use std::sync::Arc;

use alice_architecture::repository::DbField;
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{
            node_instance::{DbNodeInstance, NodeInstanceKind},
            task::TaskStatus,
            workflow_instance::NodeSpec,
        },
        vo::{
            task_dto::{Task, TaskBody, TaskCommand},
            NodeKind,
        },
    },
    repository::NodeInstanceRepo,
    service::{QueueResourceService, ScheduleService, UsecaseParseService},
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

/// 脚本用例解析微服务
#[derive(TypedBuilder)]
pub struct ScriptUsecaseServiceImpl {
    /// 任务分发服务
    task_distribution_service: Arc<dyn ScheduleService<Info = TaskStatus>>,
    /// 队列资源服务
    queue_resource_service: Arc<dyn QueueResourceService>,
    /// 节点实例仓储
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
}

#[async_trait]
impl UsecaseParseService for ScriptUsecaseServiceImpl {
    /// 处理用例
    /// 输入 节点信息
    /// 输出 Ok
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        let task = if let NodeKind::Script { script_info } = node_spec.kind {
            Task {
                id: node_spec.id.to_owned(),
                command: TaskCommand::Start,
                body: TaskBody::ExecuteScript {
                    script_info: script_info.into(),
                },
            }
        } else {
            anyhow::bail!("Unreachable node kind.");
        };

        let queue_id = self
            .queue_resource_service
            .get_queue(node_spec.id, &node_spec.scheduling_strategy)
            .await?
            .id;
        let mut node_instance = self.node_instance_repository.get_by_id(task.id).await?;
        node_instance.queue_id = Some(queue_id);
        self.node_instance_repository
            .update(&DbNodeInstance {
                id: DbField::Set(node_instance.id),
                queue_id: DbField::Set(node_instance.queue_id),
                ..Default::default()
            })
            .await?;
        self.node_instance_repository.save_changed().await?;
        self.task_distribution_service.send_task(&task, queue_id).await
    }

    fn get_service_type(&self) -> NodeInstanceKind {
        NodeInstanceKind::Script
    }

    async fn get_cmd(&self, _node_id: String) -> anyhow::Result<Option<String>> {
        unimplemented!()
    }
}
