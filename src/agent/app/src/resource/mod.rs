mod pbs;
pub mod report;
mod slurm;
mod storage;

use std::sync::OnceLock;

use async_trait::async_trait;
use serde::Serialize;

use crate::config::SshProxyConfig;

use self::pbs::Pbs;
use self::slurm::Slurm;

pub struct Ssh<S> {
    username_host: String,
    port: String,
    _scheduler: S,
}

impl<S> Ssh<S> {
    pub fn new(username_host: String, port: String, _scheduler: S) -> Self {
        Self {
            username_host,
            port,
            _scheduler,
        }
    }

    /// Exec with ssh.
    pub async fn exec(&self, args: &[&str]) -> anyhow::Result<Vec<u8>> {
        let output = tokio::process::Command::new("ssh")
            .args(["-p", &self.port, &self.username_host])
            .args(args)
            .kill_on_drop(true)
            .output()
            .await?;
        Ok(output.stdout)
    }
}

/// Exec in local.
pub async fn exec(args: &[&str]) -> anyhow::Result<Vec<u8>> {
    let output = tokio::process::Command::new(args[0])
        .args(&args[1..])
        .kill_on_drop(true)
        .output()
        .await?;
    Ok(output.stdout)
}

static STAT: OnceLock<Box<dyn ResourceStat>> = OnceLock::new();

// TODO: 改成 scheduler, ssh
pub fn init_stat<'a>(
    scheduler: &'a str,
    ssh_proxy: &Option<SshProxyConfig>,
) -> Result<(), &'a str> {
    let x: Box<dyn ResourceStat> = match (scheduler, ssh_proxy) {
        ("pbs", None) => Box::new(Pbs),
        ("slurm", None) => Box::new(Slurm),
        ("pbs", Some(proxy)) => Box::new(Ssh::new(
            format!("{}@{}", proxy.username, proxy.host),
            proxy.port.to_string(),
            Pbs,
        )),
        ("slurm", Some(proxy)) => Box::new(Ssh::new(
            format!("{}@{}", proxy.username, proxy.host),
            proxy.port.to_string(),
            Slurm,
        )),
        _ => return Err(scheduler),
    };
    STAT.set(x).map_err(|_| scheduler)
}

#[inline]
pub fn stat() -> &'static dyn ResourceStat {
    STAT.get().unwrap().as_ref()
}

/// Gather statistics of resources
#[async_trait]
pub trait ResourceStat: Send + Sync {
    async fn total(&self) -> anyhow::Result<TotalResources>;
    async fn used(&self) -> anyhow::Result<UsedResources>;
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

impl std::fmt::Display for UsedResources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let Self {
            allocated_memory,
            allocated_cpu_count,
            used_storage,
            queuing_task_count,
            running_task_count,
            used_node_count,
        } = self;

        write!(
            f,
            "allocatedMemory={allocated_memory}, \
             allocatedCpuCount={allocated_cpu_count}, \
             usedStorage={used_storage}, \
             queuingTaskCount={queuing_task_count}, \
             runningTaskCount={running_task_count}, \
             usedNodeCount={used_node_count}"
        )
    }
}
