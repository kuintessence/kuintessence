//! The senders of background service. Using them is to limit the sending way.

use crate::command::*;

#[async_trait::async_trait]
pub trait IDownloadSender {
    async fn send(&self, command: FileTransferCommand) -> anyhow::Result<()>;
}

#[async_trait::async_trait]
pub trait IUploadSender {
    async fn send(&self, command: FileTransferCommand) -> anyhow::Result<()>;
}

#[async_trait::async_trait]
pub trait ISoftwareDeploymentSender {
    async fn send(&self, command: SoftwareDeploymentCommand) -> anyhow::Result<()>;
}

#[async_trait::async_trait]
pub trait ISubTaskReportService: Send + Sync {
    async fn report_completed_task(&self, id: &str) -> anyhow::Result<()>;
    async fn report_failed_task(&self, id: &str) -> anyhow::Result<()>;
}
