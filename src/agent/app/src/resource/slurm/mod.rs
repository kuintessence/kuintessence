mod sinfo;
mod squeue;

use anyhow::Context;
use async_trait::async_trait;

use self::sinfo::{NodeAlloc, NodeTotal};
use super::exec;
use super::storage;
use super::storage::ssh_df;
use super::ResourceStat;
use super::Ssh;
use super::{TotalResources, UsedResources};

pub struct Slurm;

#[async_trait]
impl ResourceStat for Slurm {
    async fn total(&self) -> anyhow::Result<TotalResources> {
        let output = exec(sinfo::Info::<NodeTotal>::args()).await.context("sinfo")?;
        let storage_capacity = storage::statvfs::total()?.0;
        process_total_resources(&output, storage_capacity).await
    }

    async fn used(&self) -> anyhow::Result<UsedResources> {
        let output1 = exec(sinfo::Info::<NodeAlloc>::args()).await.context("sinfo")?;
        let output2 = exec(squeue::Status::args()).await.context("squeue")?;
        let used_storage = storage::statvfs::used()?.0;
        process_used_resources(&output1, &output2, used_storage).await
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Missing field {0:?} when parsing")]
pub struct MissingFieldError(&'static str);

#[async_trait]
impl ResourceStat for Ssh<Slurm> {
    async fn total(&self) -> anyhow::Result<TotalResources> {
        let output = self.exec(sinfo::Info::<NodeTotal>::args()).await.context("ssh sinfo")?;
        let storage_capacity = ssh_df::total(&self.username_host, &self.port).await?;
        process_total_resources(&output, storage_capacity).await
    }

    async fn used(&self) -> anyhow::Result<UsedResources> {
        let output1 = self.exec(sinfo::Info::<NodeAlloc>::args()).await.context("ssh sinfo")?;
        let output2 = self.exec(squeue::Status::args()).await.context("ssh squeue")?;
        let used_storage = ssh_df::used(&self.username_host, &self.port).await?;
        process_used_resources(&output1, &output2, used_storage).await
    }
}

async fn process_total_resources(
    b: &[u8],
    storage_capacity: u64,
) -> anyhow::Result<TotalResources> {
    let info = sinfo::Info::<NodeTotal>::new(b)?;
    let resources = info.total();

    Ok(TotalResources {
        memory: resources.real_memory,
        core_number: resources.cpus,
        storage_capacity,
        node_number: info.node_count(),
    })
}

async fn process_used_resources(
    b1: &[u8],
    b2: &[u8],
    used_storage: u64,
) -> anyhow::Result<UsedResources> {
    let info = sinfo::Info::<NodeAlloc>::new(b1)?;
    let jobs_status = squeue::Status::new(b2)?;

    let resources = info.alloc();
    let (queuing_task_count, running_task_count) = jobs_status.qr_count();

    Ok(UsedResources {
        allocated_memory: resources.alloc_memory,
        allocated_cpu_count: resources.alloc_cpus,
        used_storage,
        queuing_task_count,
        running_task_count,
        used_node_count: resources.alloc_nodes,
    })
}
