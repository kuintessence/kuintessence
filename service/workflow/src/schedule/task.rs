use std::sync::Arc;

use alice_architecture::{
    message_queue::producer::{MessageQueueProducer, MessageQueueProducerTemplate},
    repository::DbField,
};
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::task::{DbTask, TaskStatus},
        vo::{
            msg::{
                ChangeMsg, Info, NodeChangeInfo, NodeStatusChange, TaskChangeInfo, TaskStatusChange,
            },
            task_dto::{self, result::TaskUsedResource, TaskCommand},
        },
    },
    repository::TaskRepo,
    service::ScheduleService,
};
use uuid::Uuid;

pub struct TaskScheduleService {
    task_repo: Arc<dyn TaskRepo>,
    mq_producer_task: Arc<dyn MessageQueueProducer>,
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
}

#[async_trait]
impl ScheduleService for TaskScheduleService {
    type Info = TaskChangeInfo;

    /// Schedule with changed status.
    async fn handle_changed(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        match info.status {
            TaskStatusChange::Queuing => {
                // Do nothing, because it is queuing on agent, wait agent for making another request.
            }

            TaskStatusChange::Running { is_recovered } => {
                // This is toggled by Workflow Start or Task Recovered or Task start after a completed task.
                // Firstly, judge whether this is toggled by agent recovered task or start workflow or start task
                // If is the former, judge is all related tasks meet the condition to make node status to Recovered.
                // If is the second or third, send task Start command to agent;

                let task = self.task_repo.get_by_id(id).await?;

                if is_recovered {
                    let tasks = self.task_repo.get_same_node_tasks(id).await?;
                    // All tasks meet the recovered condition to set node as recovered.
                    if tasks.iter().all(|t| {
                        !matches!(
                            t.status,
                            TaskStatus::Recovering
                                | TaskStatus::Paused
                                | TaskStatus::Completed
                                | TaskStatus::Terminating
                                | TaskStatus::Terminated
                                | TaskStatus::Failed
                                | TaskStatus::Pausing
                                | TaskStatus::Queuing
                        )
                    }) {
                        self.status_mq_producer
                            .send_object(
                                &ChangeMsg {
                                    id: task.node_instance_id,
                                    info: Info::Node(NodeChangeInfo {
                                        status: NodeStatusChange::Running { is_recovered: true },
                                        ..Default::default()
                                    }),
                                },
                                Some(&self.status_mq_topic),
                            )
                            .await?;
                    }
                    return Ok(());
                }

                let mut count = 5;
                loop {
                    if self
                        .mq_producer_task
                        .send(
                            &serde_json::to_string(&task_dto::Task {
                                id,
                                command: TaskCommand::Start(task.body.to_owned()),
                            })?,
                            Some(&task.queue_topic),
                        )
                        .await
                        .is_ok()
                    {
                        break;
                    }

                    count -= 1;
                    if count == 0 {
                        self.change(
                            id,
                            TaskChangeInfo {
                                status: TaskStatusChange::Failed,
                                message: Some("Failed to send task to agent.".to_string()),
                                used_resources: Default::default(),
                            },
                        )
                        .await?;
                    }
                }
            }

            TaskStatusChange::Completed => {
                // Firstly, get the node related tasks list.
                // Then, judge if all tasks meet the condition to continue.
                // Otherwise, get tasks in status: Standby, run runnable tasks(The same type from the first one) in the list. If the list is
                // empty, report node as Completed.

                let tasks = self.task_repo.get_same_node_tasks(id).await?;

                if tasks.iter().any(|t| {
                    matches!(
                        t.status,
                        TaskStatus::Recovering
                            | TaskStatus::Paused
                            | TaskStatus::Running
                            | TaskStatus::Terminating
                            | TaskStatus::Terminated
                            | TaskStatus::Failed
                            | TaskStatus::Pausing
                            | TaskStatus::Queuing
                    )
                }) {
                    // Do nothing, wait for the next Completed.
                    return Ok(());
                }

                let node_instance_id = self.task_repo.get_by_id(id).await?.node_instance_id;

                let first_stand_by_task =
                    tasks.iter().find(|t| matches!(t.status, TaskStatus::Standby));

                // If no stand by task, means node can be set to Completed.
                if first_stand_by_task.is_none() {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node_instance_id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Completed,
                                    message: info.message,
                                    used_resources: info.used_resources,
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                    return Ok(());
                }

                // iF there is stand by task, change this and all same type tasks to Running.
                let first_stand_by_task = first_stand_by_task.unwrap();
                for task in tasks.iter().filter(|t| t.r#type == first_stand_by_task.r#type) {
                    self.change(
                        task.id,
                        TaskChangeInfo {
                            status: TaskStatusChange::Running {
                                is_recovered: false,
                            },
                            ..Default::default()
                        },
                    )
                    .await?;
                }
            }

            TaskStatusChange::Failed => {
                // Report node as Failed.

                let node_id = self.task_repo.get_by_id(id).await?.node_instance_id;
                self.status_mq_producer
                    .send_object(
                        &ChangeMsg {
                            id: node_id,
                            info: Info::Node(NodeChangeInfo {
                                status: NodeStatusChange::Failed,
                                message: info.message,
                                used_resources: info.used_resources,
                            }),
                        },
                        Some(&self.status_mq_topic),
                    )
                    .await?;
            }

            TaskStatusChange::Terminating => {
                // This is generate from co.
                // Use TaskDistribute Service to send task terminating command.

                let task = self.task_repo.get_by_id(id).await?;
                self.mq_producer_task
                    .send(
                        &serde_json::to_string(&task_dto::Task {
                            id,
                            command: TaskCommand::Delete(task.r#type.into()),
                        })?,
                        Some(&task.queue_topic),
                    )
                    .await?;
            }

            TaskStatusChange::Terminated => {
                // This is generated from agent.
                // Firstly, get the node related tasks list.
                // Then, judge if all tasks are: Standby or Completed or Failed or Terminated or
                // Paused.
                // If so, report node as Terminated.

                let node_id = self.task_repo.get_by_id(id).await?.node_instance_id;
                let tasks = self.task_repo.get_same_node_tasks(id).await?;
                if tasks.iter().all(|t| {
                    matches!(
                        t.status,
                        TaskStatus::Standby
                            | TaskStatus::Completed
                            // | TaskStatus::Failed
                            | TaskStatus::Terminated
                            | TaskStatus::Paused,
                    )
                }) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node_id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Terminated,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }

            TaskStatusChange::Pausing => {
                // Use TaskDistribute Service to send task pause command.

                let task = self.task_repo.get_by_id(id).await?;
                self.mq_producer_task
                    .send(
                        &serde_json::to_string(&task_dto::Task {
                            id,
                            command: TaskCommand::Pause(task.r#type.into()),
                        })?,
                        Some(&task.queue_topic),
                    )
                    .await?;
            }

            TaskStatusChange::Paused => {
                // Firstly, get the node related taks list.
                // Then, judge if all tasks are: Standby or Completed

                let node_id = self.task_repo.get_by_id(id).await?.node_instance_id;
                let tasks = self.task_repo.get_same_node_tasks(id).await?;
                if tasks.iter().all(|t| {
                    matches!(
                        t.status,
                        TaskStatus::Standby
                            | TaskStatus::Completed
                            // | TaskStatus::Failed
                            // | TaskStatus::Terminated
                            | TaskStatus::Paused
                    )
                }) {
                    self.status_mq_producer
                        .send_object(
                            &ChangeMsg {
                                id: node_id,
                                info: Info::Node(NodeChangeInfo {
                                    status: NodeStatusChange::Paused,
                                    ..Default::default()
                                }),
                            },
                            Some(&self.status_mq_topic),
                        )
                        .await?;
                }
            }

            TaskStatusChange::Recovering => {
                // Use TaskDistribute Service to send task recover command.

                let task = self.task_repo.get_by_id(id).await?;
                self.mq_producer_task
                    .send(
                        &serde_json::to_string(&task_dto::Task {
                            id,
                            command: TaskCommand::Continue(task.r#type.into()),
                        })?,
                        Some(&task.queue_topic),
                    )
                    .await?;
            }
        }
        Ok(())
    }

    /// Change status and call handle_changed.
    async fn change(&self, id: Uuid, info: Self::Info) -> anyhow::Result<()> {
        self.task_repo
            .update(&DbTask {
                id: DbField::Set(id),
                status: DbField::Set(info.status.to_owned().into()),
                message: match &info.message {
                    m @ Some(_) => DbField::Set(m.to_owned()),
                    None => DbField::NotSet,
                },
                used_resources: match &info.used_resources {
                    u @ Some(_) => DbField::Set(
                        u.as_ref().map(serde_json::to_string::<TaskUsedResource>).transpose()?,
                    ),
                    None => DbField::NotSet,
                },
                ..Default::default()
            })
            .await?;
        self.task_repo.save_changed().await?;

        self.handle_changed(id, info).await
    }
}
