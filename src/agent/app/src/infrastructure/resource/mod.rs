mod pbs;
mod slurm;
mod storage;

use std::sync::Arc;

use serde::Serialize;

use self::pbs::Pbs;
use self::slurm::Slurm;
use self::storage::stat;

use super::ssh_proxy::SshProxy;

pub struct ResourceStat {
    ssh_proxy: Arc<SshProxy>,
    scheduler: Box<dyn SchedulerStat>,
}

impl ResourceStat {
    pub fn new(scheduler: &str, ssh_proxy: Arc<SshProxy>) -> Option<Self> {
        Some(Self {
            ssh_proxy,
            scheduler: match scheduler {
                "slurm" => Box::new(Slurm),
                "pbs" => Box::new(Pbs),
                _ => return None,
            },
        })
    }

    pub async fn total(&self) -> anyhow::Result<TotalResources> {
        let SchedulerTotalResources {
            memory,
            core_number,
            node_number,
        } = self.scheduler.total(&self.ssh_proxy).await?;
        let storage_capacity = self.total_storage().await?;

        Ok(TotalResources {
            memory,
            core_number,
            storage_capacity,
            node_number,
        })
    }

    pub async fn used(&self) -> anyhow::Result<UsedResources> {
        let SchedulerUsedResources {
            allocated_memory,
            allocated_cpu_count,
            queuing_task_count,
            running_task_count,
            used_node_count,
        } = self.scheduler.used(&self.ssh_proxy).await?;
        let used_storage = self.used_storage().await?;

        Ok(UsedResources {
            allocated_memory,
            allocated_cpu_count,
            used_storage,
            queuing_task_count,
            running_task_count,
            used_node_count,
        })
    }

    async fn total_storage(&self) -> anyhow::Result<u64> {
        if self.ssh_proxy.is_proxy() {
            stat::total(&self.ssh_proxy).await
        } else {
            Ok(storage::statvfs::total()?)
        }
    }

    async fn used_storage(&self) -> anyhow::Result<u64> {
        if self.ssh_proxy.is_proxy() {
            stat::used(&self.ssh_proxy).await
        } else {
            Ok(storage::statvfs::used()?)
        }
    }
}

#[async_trait::async_trait]
trait SchedulerStat: Send + Sync {
    async fn total(&self, proxy: &SshProxy) -> anyhow::Result<SchedulerTotalResources>;
    async fn used(&self, proxy: &SshProxy) -> anyhow::Result<SchedulerUsedResources>;
}

/// Total resources counted by scheduler
#[derive(Debug)]
struct SchedulerTotalResources {
    memory: u64,
    core_number: usize,
    node_number: usize,
}

/// Used resources counted by scheduler
#[derive(Debug)]
struct SchedulerUsedResources {
    allocated_memory: u64,
    allocated_cpu_count: usize,
    queuing_task_count: usize,
    running_task_count: usize,
    used_node_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalResources {
    memory: u64,
    core_number: usize,
    storage_capacity: u64,
    node_number: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsedResources {
    allocated_memory: u64,
    allocated_cpu_count: usize,
    used_storage: u64,
    queuing_task_count: usize,
    running_task_count: usize,
    used_node_count: usize,
}
