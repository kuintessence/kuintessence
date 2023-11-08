use std::sync::Arc;

use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{node_instance::NodeInstanceKind, workflow_instance::NodeSpec},
        vo::task_dto::result::{TaskResult, TaskResultStatus},
    },
    service::UsecaseParseService,
};
use uuid::Uuid;

/// 软件用例解析微服务
pub struct NoActionUsecaseServiceImpl {
    message_producer: Arc<dyn MessageQueueProducerTemplate<TaskResult>>,
}

impl NoActionUsecaseServiceImpl {
    pub fn new(message_producer: Arc<dyn MessageQueueProducerTemplate<TaskResult>>) -> Self {
        Self { message_producer }
    }
}

#[async_trait]
impl UsecaseParseService for NoActionUsecaseServiceImpl {
    /// 处理用例
    /// 输入 节点信息
    /// 输出 Ok
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        let task_result: TaskResult = TaskResult {
            id: node_spec.id,
            status: TaskResultStatus::Completed,
            message: None,
            used_resources: None,
        };
        self.message_producer.send_object(&task_result, Some("node_status")).await?;

        Ok(())
    }

    fn get_service_type(&self) -> NodeInstanceKind {
        NodeInstanceKind::NoAction
    }

    async fn get_cmd(&self, _node_id: Uuid) -> anyhow::Result<Option<String>> {
        unimplemented!()
    }
}
