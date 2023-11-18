use std::sync::Arc;

use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate, repository::DbField,
};
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::task::{DbTask, TaskStatus},
        vo::{
            msg::{NodeChangeInfo, NodeStatusChange, TaskChangeInfo, TaskStatusChange},
            task_dto::{self, result::TaskUsedResource, TaskCommand, TaskType},
        },
    },
    repository::TaskRepo,
    service::ScheduleService,
};
use uuid::Uuid;

pub struct TaskScheduleService {
    task_repo: Arc<dyn TaskRepo>,
    mq_producer_task_body: Arc<dyn MessageQueueProducerTemplate<task_dto::Task<String>>>,
    mq_producer_task_command: Arc<dyn MessageQueueProducerTemplate<task_dto::Task<TaskType>>>,
    node_schedule_service: Arc<dyn ScheduleService<Info = NodeChangeInfo>>,
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
                // If is the former, do nothing.
                // If is the second or third, send task task command;

                if is_recovered {
                    return Ok(());
                }

                let task = self.task_repo.get_by_id(id).await?;
                self.mq_producer_task_body
                    .send_object(
                        &task_dto::Task {
                            id,
                            command: TaskCommand::Start,
                            body: task.body,
                        },
                        Some(&task.queue_topic),
                    )
                    .await?;
            }
            TaskStatusChange::Completed => {
                // Firstly, get the node related tasks list.
                // Then, judge if there are tasks in status NOT Standby and Completed.
                // If at least one task is in the situation mentioned previously, do nothing.
                // Otherwise, get tasks in status: Standby, run runnable tasks(The same type from the first one) in the list. If the list is
                // empty, report node as Completed.

                let tasks = self.task_repo.get_same_node_tasks(id).await?;
                let node_instance_id = self.task_repo.get_by_id(id).await?.node_instance_id;
                let is_do_nothing = tasks.iter().any(|t| match t.status {
                    TaskStatus::Queuing
                    | TaskStatus::Running
                    | TaskStatus::Failed
                    | TaskStatus::Terminating
                    | TaskStatus::Terminated
                    | TaskStatus::Pausing
                    | TaskStatus::Paused
                    | TaskStatus::Recovering => true,
                    _ => false,
                });
                if is_do_nothing {
                    return Ok(());
                }

                let first_stand_by_task = tasks.iter().find(|t| {
                    if let TaskStatus::Standby = t.status {
                        true
                    } else {
                        false
                    }
                });

                if first_stand_by_task.is_none() {
                    self.node_schedule_service
                        .change(
                            node_instance_id,
                            NodeChangeInfo {
                                status: NodeStatusChange::Completed,
                                ..Default::default()
                            },
                        )
                        .await?;
                    return Ok(());
                }

                let first_stand_by_task = first_stand_by_task.unwrap();
                for task in tasks.iter().filter(|t| {
                    if t.r#type == first_stand_by_task.r#type {
                        true
                    } else {
                        false
                    }
                }) {
                    self.change(
                        task.id,
                        TaskChangeInfo {
                            status: TaskStatusChange::Running {
                                is_recovered: false,
                            },
                            ..Default::default()
                        },
                    );
                }
            }
            TaskStatusChange::Failed => {
                // Report node as Failed.

                let node_id = self.task_repo.get_by_id(id).await?.node_instance_id;
                self.node_schedule_service
                    .change(
                        node_id,
                        NodeChangeInfo {
                            status: NodeStatusChange::Failed,
                            message: info.message,
                            used_resources: info.used_resources,
                        },
                    )
                    .await?;
            }
            TaskStatusChange::Terminating => {
                // This is generate from co.
                // Use TaskDistribute Service to send task terminating command.

                let task = self.task_repo.get_by_id(id).await?;
                self.mq_producer_task_command
                    .send_object(
                        &task_dto::Task {
                            id,
                            command: TaskCommand::Delete,
                            body: task.r#type.into(),
                        },
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
                let node_terminated = tasks.iter().all(|t| match t.status {
                    TaskStatus::Standby => true,
                    TaskStatus::Completed => true,
                    TaskStatus::Failed => true,
                    TaskStatus::Terminated => true,
                    TaskStatus::Paused => true,
                    _ => false,
                });

                if node_terminated {
                    self.node_schedule_service
                        .change(
                            node_id,
                            NodeChangeInfo {
                                status: NodeStatusChange::Terminated,
                                ..Default::default()
                            },
                        )
                        .await?;
                }
            }
            TaskStatusChange::Pausing => {
                // Use TaskDistribute Service to send task pause command.

                let task = self.task_repo.get_by_id(id).await?;
                self.mq_producer_task_command
                    .send_object(
                        &task_dto::Task {
                            id,
                            command: TaskCommand::Pause,
                            body: task.r#type.into(),
                        },
                        Some(&task.queue_topic),
                    )
                    .await?;
            }
            TaskStatusChange::Paused => {
                // Firstly, get the node related taks list.
                // Then, judge if all tasks are: Standby or Completed

                let node_id = self.task_repo.get_by_id(id).await?.node_instance_id;
                let tasks = self.task_repo.get_same_node_tasks(id).await?;
                let node_paused = tasks.iter().all(|t| match t.status {
                    TaskStatus::Standby => true,
                    TaskStatus::Completed => true,
                    TaskStatus::Failed => true,
                    TaskStatus::Terminated => true,
                    TaskStatus::Paused => true,
                    _ => false,
                });

                if node_paused {
                    self.node_schedule_service
                        .change(
                            node_id,
                            NodeChangeInfo {
                                status: NodeStatusChange::Paused,
                                ..Default::default()
                            },
                        )
                        .await?;
                }
            }
            TaskStatusChange::Recovering => {
                // Use TaskDistribute Service to send task recover command.

                let task = self.task_repo.get_by_id(id).await?;
                self.mq_producer_task_command
                    .send_object(
                        &task_dto::Task {
                            id,
                            command: TaskCommand::Continue,
                            body: task.r#type.into(),
                        },
                        Some(&task.queue_topic),
                    )
                    .await?;
            }
        }
        todo!()
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
