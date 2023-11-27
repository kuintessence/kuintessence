use std::sync::Arc;

use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate, repository::DbField,
};
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::{
            node_instance::{DbNodeInstance, NodeInstanceStatus},
            task::TaskStatus,
        },
        vo::msg::{
            ChangeMsg, FlowStatusChange, Info, NodeChangeInfo, NodeStatusChange, TaskChangeInfo,
            TaskStatusChange,
        },
    },
    repository::{NodeInstanceRepo, TaskRepo, WorkflowInstanceRepo},
    service::{ScheduleService, UsecaseSelectService},
};
use uuid::Uuid;

use super::batch::BatchService;

pub struct NodeScheduleService {
    node_repo: Arc<dyn NodeInstanceRepo>,
    flow_repo: Arc<dyn WorkflowInstanceRepo>,
    task_repo: Arc<dyn TaskRepo>,
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
    usecase_select_service: Arc<dyn UsecaseSelectService>,
    batch_service: Arc<BatchService>,
}

#[async_trait]
impl ScheduleService for NodeScheduleService {
    type Info = NodeChangeInfo;

    /// Handle a changed target item.
    async fn handle_changed(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        match info.status {
            NodeStatusChange::Pending => {
                // Toggled by workflow start scheduling, send the node spec to usecase service and
                // wait usecase service to send Task Running change.

                let node_spec = self.node_repo.get_node_spec(id).await?;
                self.usecase_select_service.send_usecase(node_spec).await?;
            }
            NodeStatusChange::Running { is_recovered } => {
                // Toggled by:
                // 1. Workflow start scheduling, and the first nodes to run;
                // 2. Recovered node that notified by TaskScheduleService;
                // 3. Next running nodes notified by TaskScheduleService.
                // If is 1 or 3, send node_spec to usecase service to generate task;
                // If is 2, judge is all related nodes meet the condition to make batch_parent as
                // recovered, and if meet the condition to make workflow as recovered.

                let node = self.node_repo.get_by_id(id).await?;

                if is_recovered {
                    if let Some(parent_id) = node.batch_parent_id {
                        let same_batch_nodes =
                            self.node_repo.get_node_sub_node_instances(parent_id).await?;
                        if same_batch_nodes
                            .iter()
                            .all(|n| !matches!(n.status, NodeInstanceStatus::Recovering))
                        {
                            self.status_mq_producer
                                .send_object(
                                    &ChangeMsg {
                                        id: parent_id,
                                        info: Info::Node(NodeChangeInfo {
                                            status: NodeStatusChange::Running {
                                                is_recovered: true,
                                            },
                                            ..Default::default()
                                        }),
                                    },
                                    Some(&self.status_mq_topic),
                                )
                                .await?;
                        }
                        return Ok(());
                    }
                    let nodes = self
                        .node_repo
                        .get_all_workflow_instance_nodes(node.flow_instance_id)
                        .await?;
                    if nodes.iter().all(|n| !matches!(n.status, NodeInstanceStatus::Recovering)) {
                        self.status_mq_producer
                            .send_object(
                                &ChangeMsg {
                                    id: node.flow_instance_id,
                                    info: Info::Flow(FlowStatusChange::Running {
                                        is_recovered: true,
                                    }),
                                },
                                Some(&self.status_mq_topic),
                            )
                            .await?;
                    }
                    return Ok(());
                }
                self.status_mq_producer
                    .send_object(
                        &ChangeMsg {
                            id: node.flow_instance_id,
                            info: Info::Flow(FlowStatusChange::Running {
                                is_recovered: false,
                            }),
                        },
                        Some(&self.status_mq_topic),
                    )
                    .await?;
            }
            NodeStatusChange::Completed => {
                // Firstly, judge if all nodes meet the condition to continue.

                let node = self.node_repo.get_by_id(id).await?;
                let is_do_nothing = |s: &NodeInstanceStatus| {
                    matches!(
                        s,
                        NodeInstanceStatus::Recovering
                            | NodeInstanceStatus::Paused
                            | NodeInstanceStatus::Running
                            | NodeInstanceStatus::Terminating
                            | NodeInstanceStatus::Terminated
                            | NodeInstanceStatus::Failed
                            | NodeInstanceStatus::Pausing
                            | NodeInstanceStatus::Pending
                    )
                };

                if let Some(parent_id) = node.batch_parent_id {
                    let same_batch_nodes =
                        self.node_repo.get_node_sub_node_instances(parent_id).await?;
                    if same_batch_nodes.iter().any(|n| is_do_nothing(&n.status)) {
                        return Ok(());
                    }
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: parent_id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Completed,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                    return Ok(());
                }

                let nodes =
                    self.node_repo.get_all_workflow_instance_nodes(node.flow_instance_id).await?;

                if nodes.iter().any(|n| is_do_nothing(&n.status)) {
                    return Ok(());
                }

                let flow = self.flow_repo.get_by_id(node.flow_instance_id).await?;

                let unscheduled_nodes_ids = nodes
                    .iter()
                    .filter(|n| matches!(n.status, NodeInstanceStatus::Standby))
                    .map(|n| n.id)
                    .collect::<Vec<_>>();

                let node_dependencies: Vec<(Uuid, Uuid)> = flow
                    .spec
                    .node_relations
                    .iter()
                    .filter(|el| el.from_id.ne(&id) && el.to_id.ne(&id))
                    .map(|el| (el.from_id.to_owned(), el.to_id.to_owned()))
                    .collect();

                let entry_nodes_ids =
                    BatchService::find_entry_nodes_ids(&unscheduled_nodes_ids, &node_dependencies)
                        .await;

                if entry_nodes_ids.is_empty() {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node.flow_instance_id,
                                info: Info::Flow(FlowStatusChange::Completed),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                    return Ok(());
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
            NodeStatusChange::Failed => {
                let flow_id = self.node_repo.get_by_id(id).await?.flow_instance_id;
                self.status_mq_producer
                    .send_object(
                        &ChangeMsg {
                            id: flow_id,
                            info: Info::Flow(FlowStatusChange::Failed),
                        },
                        Some(&self.status_mq_topic),
                    )
                    .await?;
            }
            NodeStatusChange::Terminating => {
                let tasks = self.task_repo.get_tasks_by_node_id(id).await?;

                for task in tasks.iter().filter(|t| {
                    matches!(
                        t.status,
                        TaskStatus::Running | TaskStatus::Queuing | TaskStatus::Paused
                    )
                }) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: task.id,
                                info: Info::Task(TaskChangeInfo {
                                    status: TaskStatusChange::Terminating,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            NodeStatusChange::Terminated => {
                let node = self.node_repo.get_by_id(id).await?;
                let can_make_super_as_terminated = |s: &NodeInstanceStatus| {
                    matches!(
                        s,
                        NodeInstanceStatus::Standby
                            | NodeInstanceStatus::Terminated
                            | NodeInstanceStatus::Completed
                    )
                };
                if let Some(parent_id) = node.batch_parent_id {
                    let batch_nodes = self.node_repo.get_node_sub_node_instances(parent_id).await?;
                    if batch_nodes.iter().all(|n| can_make_super_as_terminated(&n.status)) {
                        self.status_mq_producer
                            .send_object(
                                &ChangeMsg {
                                    id: parent_id,
                                    info: Info::Node(NodeChangeInfo {
                                        status: NodeStatusChange::Terminated,
                                        ..Default::default()
                                    }),
                                },
                                Some(&self.status_mq_topic),
                            )
                            .await?;
                    }
                    return Ok(());
                }
                let nodes =
                    self.node_repo.get_all_workflow_instance_nodes(node.flow_instance_id).await?;
                if nodes.iter().all(|n| can_make_super_as_terminated(&n.status)) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node.flow_instance_id,
                                info: Info::Flow(FlowStatusChange::Terminated),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            NodeStatusChange::Standby => {
                // Toggled by flow instance start.
                // In this branch, do nothing.
            }
            NodeStatusChange::Pausing => {
                // Similar as other 'ing' command.
                let tasks = self.task_repo.get_tasks_by_node_id(id).await?;

                for task in tasks
                    .iter()
                    .filter(|t| matches!(t.status, TaskStatus::Running | TaskStatus::Queuing))
                {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: task.id,
                                info: Info::Task(TaskChangeInfo {
                                    status: TaskStatusChange::Pausing,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            NodeStatusChange::Paused => {
                // Check if has parent, judege whether can change node parent status, then judege
                // whether can change flow status.

                let node = self.node_repo.get_by_id(id).await?;
                let can_make_super_as_paused = |s: &NodeInstanceStatus| {
                    matches!(
                        s,
                        NodeInstanceStatus::Completed
                            | NodeInstanceStatus::Standby
                            | NodeInstanceStatus::Paused
                    )
                };
                if let Some(parent_id) = node.batch_parent_id {
                    let batch_nodes = self.node_repo.get_node_sub_node_instances(parent_id).await?;
                    if batch_nodes.iter().all(|n| can_make_super_as_paused(&n.status)) {
                        self.status_mq_producer
                            .send_object(
                                &ChangeMsg {
                                    id: parent_id,
                                    info: Info::Node(NodeChangeInfo {
                                        status: NodeStatusChange::Paused,
                                        ..Default::default()
                                    }),
                                },
                                Some(&self.status_mq_topic),
                            )
                            .await?;
                    }
                    return Ok(());
                }
                let nodes =
                    self.node_repo.get_all_workflow_instance_nodes(node.flow_instance_id).await?;
                if nodes.iter().all(|n| can_make_super_as_paused(&n.status)) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node.flow_instance_id,
                                info: Info::Flow(FlowStatusChange::Paused),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
            NodeStatusChange::Recovering => {
                // Similar as other 'ing' command.
                let tasks = self.task_repo.get_tasks_by_node_id(id).await?;

                for task in tasks.iter().filter(|t| matches!(t.status, TaskStatus::Paused)) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: task.id,
                                info: Info::Task(TaskChangeInfo {
                                    status: TaskStatusChange::Recovering,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }
        }
        Ok(())
    }

    /// Change an target item.
    async fn change(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        self.node_repo
            .update(&DbNodeInstance {
                status: DbField::Set(info.status.clone().into()),
                log: match &info.message {
                    m @ Some(_) => DbField::Set(m.to_owned()),
                    None => DbField::NotSet,
                },
                resource_meter: match &info.used_resources {
                    u @ Some(_) => DbField::Set(u.as_ref().map(|u| u.to_owned().into())),
                    None => DbField::NotSet,
                },
                ..Default::default()
            })
            .await?;
        self.node_repo.save_changed().await?;
        self.handle_changed(id, info).await
    }
}
