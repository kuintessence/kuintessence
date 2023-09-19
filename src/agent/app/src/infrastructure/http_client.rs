use std::sync::Arc;

use domain::{repository::ITaskRepository, service::TaskReportService};
use reqwest::Url;
use typed_builder::TypedBuilder;
use uuid::Uuid;

use crate::{
    dto::{Reply, TaskResult, TaskUsedResource},
    infrastructure::token::TokenManager,
};

#[derive(TypedBuilder)]
pub struct HttpClient {
    base: reqwest::Client,
    token_manager: Arc<TokenManager>,
    base_url: Url,
    repo: Arc<dyn ITaskRepository + Send + Sync>,
}

#[async_trait::async_trait]
impl TaskReportService for HttpClient {
    async fn report_completed_task(&self, id: &str) -> anyhow::Result<()> {
        let task = self.repo.get_by_id(id).await?;
        let used_resources = task
            .body
            .iter()
            .cloned()
            .find(|x| x.resource_used.is_some())
            .unwrap_or_default()
            .resource_used;
        self.http_post(
            &self.base_url.join("workflow-engine/ReceiveNodeStatus").unwrap(),
            &TaskResult {
                id: id.to_string(),
                status: crate::dto::TaskResultStatus::Success,
                used_resources: used_resources.map(|used_resources| TaskUsedResource {
                    cpu: used_resources.cpu,
                    avg_memory: used_resources.avg_memory,
                    max_memory: used_resources.max_memory,
                    storage: used_resources.storage,
                    wall_time: used_resources.wall_time,
                    cpu_time: used_resources.cpu_time,
                    node: used_resources.node,
                    start_time: used_resources.start_time,
                    end_time: used_resources.end_time,
                }),
                ..Default::default()
            },
            3,
            1000,
        )
        .await?;
        Ok(())
    }

    async fn report_failed_task(&self, id: &str, message: &str) -> anyhow::Result<()> {
        self.http_post(
            &self.base_url.join("workflow-engine/ReceiveNodeStatus").unwrap(),
            &TaskResult {
                id: id.to_string(),
                status: crate::dto::TaskResultStatus::Failed,
                message: message.to_string(),
                ..Default::default()
            },
            3,
            1000,
        )
        .await?;
        Ok(())
    }

    async fn report_paused_task(&self, id: &str) -> anyhow::Result<()> {
        self.http_post(
            &self.base_url.join("workflow-engine/ReceiveNodeStatus").unwrap(),
            &TaskResult {
                id: id.to_string(),
                status: crate::dto::TaskResultStatus::Paused,
                ..Default::default()
            },
            3,
            1000,
        )
        .await?;
        Ok(())
    }

    async fn report_resumed_task(&self, id: &str) -> anyhow::Result<()> {
        self.http_post(
            &self.base_url.join("workflow-engine/ReceiveNodeStatus").unwrap(),
            &TaskResult {
                id: id.to_string(),
                status: crate::dto::TaskResultStatus::Continued,
                ..Default::default()
            },
            3,
            1000,
        )
        .await?;
        Ok(())
    }

    async fn report_deleted_task(&self, id: &str) -> anyhow::Result<()> {
        self.http_post(
            &self.base_url.join("workflow-engine/ReceiveNodeStatus").unwrap(),
            &TaskResult {
                id: id.to_string(),
                status: crate::dto::TaskResultStatus::Deleted,
                ..Default::default()
            },
            3,
            1000,
        )
        .await?;
        Ok(())
    }

    async fn report_started_task(&self, id: &str) -> anyhow::Result<()> {
        self.http_post(
            &self.base_url.join("workflow-engine/ReceiveNodeStatus").unwrap(),
            &TaskResult {
                id: id.to_string(),
                status: crate::dto::TaskResultStatus::Start,
                ..Default::default()
            },
            3,
            1000,
        )
        .await?;
        Ok(())
    }
}

impl HttpClient {
    async fn http_post<'a, REQ>(
        &self,
        url: &url::Url,
        body: &REQ,
        max_times: u64,
        timeout: u64,
    ) -> anyhow::Result<Reply<Uuid>>
    where
        REQ: serde::Serialize,
    {
        let client = self.base.clone();
        let mut times = 1u64;
        loop {
            tokio::select! {
                x = self.token_manager.send(&client, client.post(url.clone()).json(body)) => {
                    match x {
                        Ok(x) => {
                            if !x.is_ok() {
                                times += 1;
                                if times == max_times {
                                    return Err(x.error().into());
                                }
                                sleep(times).await;
                                continue;
                            }
                            break Ok(x);
                        },
                        Err(e) => {
                            times += 1;
                            if times == max_times {
                                return Err(e.into());
                            }
                            sleep(times).await;
                            continue;
                        }
                    };
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(timeout)) => {
                    times += 1;
                    if times == max_times {
                        return Err(anyhow::anyhow!("request timeout"));
                    }
                    sleep(times).await;
                    continue;
                }
            }
        }
    }
}

async fn sleep(time: u64) {
    let sleep_time = {
        let sleep_time = rand::random::<u8>() as u64;
        let jitter = rand::random::<u8>() as u64;
        (if sleep_time > 0 && sleep_time <= 10 {
            sleep_time * 1000
        } else if sleep_time > 10 && sleep_time <= 100 {
            sleep_time * 100
        } else {
            1000
        }) + jitter
    } * time;
    tokio::time::sleep(tokio::time::Duration::from_millis(sleep_time)).await;
}
