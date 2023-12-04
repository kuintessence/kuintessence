use std::sync::Arc;

use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{node_instance::NodeInstanceKind, workflow_instance::NodeSpec},
        vo::msg::{ChangeMsg, Info, NodeChangeInfo, NodeStatusChange},
    },
    service::UsecaseParseService,
};
use typed_builder::TypedBuilder;
use uuid::Uuid;

/// 软件用例解析微服务
#[derive(TypedBuilder)]
pub struct NoActionUsecaseServiceImpl {
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
}

#[async_trait]
impl UsecaseParseService for NoActionUsecaseServiceImpl {
    /// 处理用例
    /// 输入 节点信息
    /// 输出 Ok
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        self.status_mq_producer
            .send_object(
                &ChangeMsg {
                    id: node_spec.id,
                    info: Info::Node(NodeChangeInfo {
                        status: NodeStatusChange::Completed,
                        ..Default::default()
                    }),
                },
                Some(&self.status_mq_topic),
            )
            .await
            .map_err(|e| anyhow::anyhow!("send message failed: {}", e))?;
        Ok(())
    }

    fn get_service_type(&self) -> NodeInstanceKind {
        NodeInstanceKind::NoAction
    }

    async fn get_cmd(&self, _node_id: Uuid) -> anyhow::Result<Option<String>> {
        unimplemented!()
    }
}
