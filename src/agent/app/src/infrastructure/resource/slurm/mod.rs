mod sinfo;
mod squeue;

use anyhow::bail;
use anyhow::Context;
use async_trait::async_trait;

use crate::infrastructure::ssh_proxy::SshProxy;

use self::sinfo::{NodeAlloc, NodeTotal};
use super::{SchedulerStat, SchedulerTotalResources, SchedulerUsedResources};

pub struct Slurm;

#[async_trait]
impl SchedulerStat for Slurm {
    async fn total(&self, proxy: &SshProxy) -> anyhow::Result<SchedulerTotalResources> {
        let output = proxy
            .command("sinfo")
            .args(sinfo::Info::<NodeTotal>::ARGS)
            .output()
            .await
            .context("sinfo")?;
        if !output.status.success() {
            bail!(
                "sinfo terminated with an exception. Exit status: {}",
                output.status
            );
        }

        let info = sinfo::Info::<NodeTotal>::new(&output.stdout)?;
        let resources = info.total();
        Ok(SchedulerTotalResources {
            memory: resources.memory,
            core_number: resources.cpus,
            node_number: info.node_count(),
        })
    }

    async fn used(&self, proxy: &SshProxy) -> anyhow::Result<SchedulerUsedResources> {
        let output = proxy
            .command("sinfo")
            .args(sinfo::Info::<NodeAlloc>::ARGS)
            .output()
            .await
            .context("sinfo")?;
        if !output.status.success() {
            bail!(
                "sinfo terminated with an exception. Exit status: {}",
                output.status
            );
        }
        let info = sinfo::Info::<NodeAlloc>::new(&output.stdout)?;

        let output = proxy
            .command("squeue")
            .args(squeue::Status::ARGS)
            .output()
            .await
            .context("squeue")?;
        if !output.status.success() {
            bail!(
                "squeue terminated with an exception. Exit status: {}",
                output.status
            );
        }
        let jobs_status = squeue::Status::new(&output.stdout);

        let resources = info.alloc();
        let (queuing_task_count, running_task_count) = jobs_status.qr_count();
        Ok(SchedulerUsedResources {
            allocated_memory: resources.alloc_memory,
            allocated_cpu_count: resources.alloc_cpus,
            queuing_task_count,
            running_task_count,
            used_node_count: resources.alloc_nodes,
        })
    }
}
