use std::sync::Arc;

use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate, repository::DbField,
};
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{node_instance::NodeInstanceStatus, workflow_instance::DbWorkflowInstance},
        vo::msg::{ChangeMsg, FlowStatusChange, Info, NodeChangeInfo, NodeStatusChange},
    },
    repository::{NodeInstanceRepo, WorkflowInstanceRepo},
    service::ScheduleService,
};
use uuid::Uuid;

use crate::schedule::batch::BatchService;

#[derive(typed_builder::TypedBuilder)]
pub struct FlowScheduleServiceImpl {
    flow_repo: Arc<dyn WorkflowInstanceRepo>,
    node_repo: Arc<dyn NodeInstanceRepo>,
    batch_service: Arc<BatchService>,
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
}

#[async_trait]
impl ScheduleService for FlowScheduleServiceImpl {
    type Info = FlowStatusChange;

    async fn handle_changed(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        let flow = self.flow_repo.get_by_id(id).await?;
        match info {
            FlowStatusChange::Pending => {
                let node_specs = flow.spec.node_specs.to_owned();
                let node_dep_by_id: Vec<(Uuid, Uuid)> = flow
                    .spec
                    .node_relations
                    .iter()
                    .map(|el| (el.from_id.to_owned(), el.to_id.to_owned()))
                    .collect();
                let node_ids = node_specs.iter().map(|el| el.id.to_owned()).collect::<Vec<_>>();
                let entry_nodes_ids =
                    BatchService::find_entry_nodes_ids(&node_ids, &node_dep_by_id).await;
                for node_spec in node_specs.iter() {
                    if !entry_nodes_ids.contains(&node_spec.id) {
                        self.status_mq_producer
                            .send_object(
                                &ChangeMsg {
                                    id: node_spec.id,
                                    info: Info::Node(NodeChangeInfo {
                                        status: NodeStatusChange::Standby,
                                        ..Default::default()
                                    }),
                                },
                                Some(&self.status_mq_topic),
                            )
                            .await?;
                        if !node_spec.batch_strategies.is_empty() {
                            let sub_node_instances =
                                self.node_repo.get_node_sub_node_instances(node_spec.id).await?;
                            for n in sub_node_instances.iter() {
                                self.status_mq_producer
                                    .send_object(
                                        &ChangeMsg {
                                            id: n.id,
                                            info: Info::Node(NodeChangeInfo {
                                                status: NodeStatusChange::Standby,
                                                ..Default::default()
                                            }),
                                        },
                                        Some(&self.status_mq_topic),
                                    )
                                    .await?;
                            }
                        }
                    }
                }
                let task_node_specs =
                    self.batch_service.get_task_node_specs(flow, entry_nodes_ids).await?;
                for task_node_spec in task_node_specs.iter() {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: task_node_spec.id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Pending,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            FlowStatusChange::Terminating => {
                let nodes = self.node_repo.get_all_workflow_instance_nodes(id).await?;
                for node in nodes.iter().filter(|n| {
                    matches!(
                        n.status,
                        NodeInstanceStatus::Paused
                            | NodeInstanceStatus::Running
                            | NodeInstanceStatus::Pending
                    )
                }) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node.id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Terminating,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            FlowStatusChange::Pausing => {
                let nodes = self.node_repo.get_all_workflow_instance_nodes(id).await?;
                for node in nodes.iter().filter(|n| {
                    matches!(
                        n.status,
                        NodeInstanceStatus::Running | NodeInstanceStatus::Pending
                    )
                }) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node.id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Terminating,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            FlowStatusChange::Resuming => {
                let nodes = self.node_repo.get_all_workflow_instance_nodes(id).await?;
                for node in nodes.iter().filter(|n| matches!(n.status, NodeInstanceStatus::Paused))
                {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node.id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Resuming,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            FlowStatusChange::Running { .. }
            | FlowStatusChange::Completed
            | FlowStatusChange::Failed
            | FlowStatusChange::Terminated
            | FlowStatusChange::Paused => {
                // Do nothing
            }
        }
        Ok(())
    }

    async fn change(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        self.flow_repo
            .update(DbWorkflowInstance {
                id: DbField::Unchanged(id),
                status: DbField::Set(info.clone().into()),
                ..Default::default()
            })
            .await?;
        self.flow_repo.save_changed().await?;
        self.handle_changed(id, info).await
    }
}
