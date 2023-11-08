use std::sync::Arc;

use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate, repository::DbField,
};
use anyhow::Context;
use async_trait::async_trait;
use domain_workflow::{
    model::{
        entity::task::{DbTask, TaskStatus, TaskType},
        vo::{
            msg::TaskChangeInfo,
            task_dto::{self, result::TaskUsedResource, TaskBody, TaskCommand},
        },
    },
    repository::{NodeInstanceRepo, TaskRepo},
    service::ScheduleService,
};
use uuid::Uuid;

pub struct TaskScheduleService {
    task_repo: Arc<dyn TaskRepo>,
    run_task_sender: Arc<dyn MessageQueueProducerTemplate<task_dto::Task<TaskBody>>>,
    cmd_task_sender: Arc<dyn MessageQueueProducerTemplate<task_dto::Task<TaskCommand>>>,
}

#[async_trait]
impl ScheduleService for TaskScheduleService {
    type Info = TaskChangeInfo;

    /// Schedule with changed status.
    async fn handle_changed(&self, id: String, info: Self::Info) -> anyhow::Result<()> {
        match info.status {
            TaskStatus::Standby => {
                anyhow::bail!(
                    "task change to standby is unimplemented because it created with standby."
                )
            }
            TaskStatus::Queuing => {
                // Do nothing, because it is queuing on agent, wait agent to make another request.
            }
            TaskStatus::Running => {
                // The caller in co must call this branch with the first task in the created task list.
                // Then get the first tasks(The same type from the first one) to run.
                // Then send task run command.

                let queue_topic = self.task_repo.get_queue_topic(id).await?;
                let tasks = self.task_repo.get_same_node_tasks(id).await?;
                let first_task = tasks
                    .first()
                    .with_context(|| format!("task list find by task id: {id} is empty"))?;
                let first_task_type = first_task.r#type;

                for task in
                    tasks.iter().filter(|t| if let TaskType = t.r#type { true } else { false })
                {
                    self.run_task_sender
                        .send_object(
                            &task_dto::Task {
                                id,
                                command: TaskCommand::Start,
                                body: ,
                            },
                            Some(queue_topic),
                        )
                        .await?;
                }
            }
            TaskStatus::Recovered => {
                if is_recover {
                    let paused_tasks = tasks
                        .into_iter()
                        .filter(|t| {
                            if let TaskStatus::Paused = t.status {
                                true
                            } else {
                                false
                            }
                        })
                        .collect::<Vec<_>>();
                    for paused_task in paused_tasks {
                        self.change(
                            paused_task.id,
                            TaskChangeInfo {
                                status: TaskStatus::Running,
                                ..Default::default()
                            },
                        )
                        .await?;
                    }
                    return Ok(());
                }
            }
            TaskStatus::Completed => {
                // Firstly, get the node related tasks list.
                // Then, judge if there are tasks Running or Queuing.
                // If at least one task is Running or Queuing, do nothing.
                // Otherwise, get tasks in status: Standby, run runnable tasks(The same type from the first one) in the list. If the list is
                // empty, report node as Completed.
            }
            TaskStatus::Failed => {
                // Report node as Failed.
            }
            TaskStatus::Terminating => {
                // This is generate from co.
                // Use TaskDistribute Service to send task terminating command.
            }
            TaskStatus::Terminated => {
                // This is generated from agent.
                // Firstly, get the node related tasks list.
                // Then, judge if all tasks are: Standby or Completed or Terminated.
                // If so, report node as Terminated.
            }
            TaskStatus::Pausing => {
                // Use TaskDistribute Service to send task pause command.
            }
            TaskStatus::Paused => {
                // Firstly, get the node related taks list.
                // Then, judge if all tasks are: Standby or Completed
            }
            TaskStatus::Recovering => {
                // Use TaskDistribute Service to send task recover command.
            }
        }
        todo!()
    }

    /// Change status and call handle_changed.
    async fn change(&self, id: String, info: Self::Info) -> anyhow::Result<()> {
        self.task_repo
            .update(&DbTask {
                id: DbField::Set(id),
                status: DbField::Set(info.status.to_owned()),
                message: match info.message {
                    m @ Some(_) => DbField::Set(m),
                    None => DbField::NotSet,
                },
                used_resources: match info.used_resources {
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
