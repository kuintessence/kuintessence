mod pbsnodes;
mod qstat;

use anyhow::Context;
use async_trait::async_trait;

use self::pbsnodes::{NodeAssigned, NodeAvailable};
use super::storage::ssh_df;
use super::{exec, storage, Ssh};
use super::{ResourceStat, TotalResources, UsedResources};

pub struct Pbs;

#[async_trait]
impl ResourceStat for Pbs {
    async fn total(&self) -> anyhow::Result<TotalResources> {
        let output = exec(pbsnodes::Status::<NodeAvailable>::args()).await.context("pbsnodes")?;
        let storage_capacity = storage::statvfs::total()?.0;
        process_total(&output, storage_capacity).await
    }

    async fn used(&self) -> anyhow::Result<UsedResources> {
        let output1 = exec(pbsnodes::Status::<NodeAssigned>::args()).await.context("pbsnodes")?;
        let output2 = exec(qstat::Status::args()).await.context("qstat")?;
        let used_storage = storage::statvfs::used()?.0;
        process_used(&output1, &output2, used_storage).await
    }
}

#[async_trait]
impl ResourceStat for Ssh<Pbs> {
    async fn total(&self) -> anyhow::Result<TotalResources> {
        let output =
            self.exec(pbsnodes::Status::<NodeAvailable>::args()).await.context("pbsnodes")?;
        let storage_capacity = ssh_df::total(&self.username_host, &self.port).await?;
        process_total(&output, storage_capacity).await
    }

    async fn used(&self) -> anyhow::Result<UsedResources> {
        let output1 = self
            .exec(pbsnodes::Status::<NodeAssigned>::args())
            .await
            .context("ssh pbsnodes")?;
        let output2 = self.exec(qstat::Status::args()).await.context("ssh qstat")?;
        let used_storage = ssh_df::used(&self.username_host, &self.port).await?;
        process_used(&output1, &output2, used_storage).await
    }
}

async fn process_total(b1: &[u8], storage_capacity: u64) -> anyhow::Result<TotalResources> {
    let status = pbsnodes::Status::<NodeAvailable>::new(b1)?;
    let resources = status.available();

    Ok(TotalResources {
        memory: resources.mem.0,
        core_number: resources.ncpus,
        storage_capacity,
        node_number: status.node_count(),
    })
}

async fn process_used(b1: &[u8], b2: &[u8], used_storage: u64) -> anyhow::Result<UsedResources> {
    let nodes_status = pbsnodes::Status::<NodeAssigned>::new(b1)?;
    let jobs_status = qstat::Status::new(b2)?;

    let (resources, used_node_count) = nodes_status.assigned();
    let (queuing_task_count, running_task_count) = jobs_status.qr_count();

    Ok(UsedResources {
        allocated_memory: resources.mem.0,
        allocated_cpu_count: resources.ncpus,
        used_storage,
        queuing_task_count,
        running_task_count,
        used_node_count,
    })
}
