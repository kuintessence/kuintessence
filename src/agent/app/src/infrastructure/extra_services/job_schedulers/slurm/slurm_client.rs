use super::SlurmJob;
use agent_core::{
    models::{Job, JobState, ScriptInfo, TaskUsedResource},
    services::IJobSchedulerService,
};
use std::path::PathBuf;
use tokio::process::Command;

pub struct SlurmClient {
    base_path: String,
    include_env: String,
    ssh_proxy: Option<crate::config::SshProxyConfig>,
}

#[async_trait::async_trait]
impl IJobSchedulerService for SlurmClient {
    async fn get_job(&self, id: &str) -> anyhow::Result<Job> {
        let out = if let Some(ssh_proxy) = self.ssh_proxy.clone() {
            Command::new("ssh")
                .arg("-p")
                .arg(ssh_proxy.port.to_string())
                .arg(format!("{}@{}", ssh_proxy.username, ssh_proxy.host))
                .arg("sacct")
                .arg("-PXo")
                .arg("JobID,JobName,User,State,ExitCode,WorkDir,CPUTimeRaw,ElapsedRaw,NCPUS,AveRSS,MaxRSS,NNodes,Start,End")
                .arg("-j")
                .arg(id)
                .output()
                .await?
        } else {
            Command::new("sacct")
            .arg("-PXo")
            .arg("JobID,JobName,User,State,ExitCode,WorkDir,CPUTimeRaw,ElapsedRaw,NCPUS,AveRSS,MaxRSS,NNodes,Start,End")
            .arg("-j")
            .arg(id)
            .output()
            .await?
        };
        if !out.status.success() {
            anyhow::bail!("Exit Status not 0. real: {}", out.status)
        }
        let mut csv_reader = csv::ReaderBuilder::new()
            .delimiter(b'|')
            .quoting(false)
            .from_reader(out.stdout.as_slice());
        let mut jobs = Vec::<Job>::new();
        for record in csv_reader.deserialize() {
            let record: SlurmJob = record?;
            jobs.push(Job {
                id: record.job_id,
                name: record.job_name,
                owner: record.user,
                state: match record.state.as_str() {
                    "BOOT_FAIL" | "FAILED" | "NODE_FAIL" | "OUT_OF_MEMORY" | "TIMEOUT"
                    | "DEADLINE" => JobState::Failed,
                    "CANCELLED" => JobState::Suspended,
                    "COMPLETED" => JobState::Completed,
                    "PENDING" => JobState::Queuing,
                    "COMPLETING" => JobState::Completing,
                    "RUNNING" => JobState::Running,
                    _ => JobState::Unknown,
                },
                exit_status_code: record.exit_code.split(':').next().unwrap_or("0").parse()?,
                error_output: tokio::fs::read_to_string(format!("{}/STDERR", record.work_dir))
                    .await
                    .unwrap_or_default(),
                resource_used: TaskUsedResource {
                    cpu: record.ncpus,
                    avg_memory: record.ave_mem,
                    max_memory: record.mem,
                    storage: 0,
                    wall_time: record.elapsed,
                    cpu_time: record.cpu_time,
                    start_time: parse_time(&record.start),
                    end_time: parse_time(&record.end),
                    node: record.nnodes,
                },
            })
        }
        match jobs.get(0).cloned() {
            Some(x) => Ok(x),
            None => anyhow::bail!("No such id"),
        }
    }
    async fn get_jobs(&self) -> anyhow::Result<Vec<Job>> {
        let out = if let Some(ssh_proxy) = self.ssh_proxy.clone() {
            Command::new("ssh")
                .arg("-p")
                .arg(ssh_proxy.port.to_string())
                .arg(format!("{}@{}", ssh_proxy.username, ssh_proxy.host))
                .arg("sacct")
                .arg("-PXo")
                .arg("JobID,JobName,User,State,ExitCode,WorkDir")
                .output()
                .await?
        } else {
            Command::new("sacct")
                .arg("-PXo")
                .arg("JobID,JobName,User,State,ExitCode,WorkDir")
                .output()
                .await?
        };
        if !out.status.success() {
            anyhow::bail!("Exit Status not 0. real: {}", out.status)
        }
        let mut csv_reader = csv::ReaderBuilder::new()
            .delimiter(b'|')
            .quoting(false)
            .from_reader(out.stdout.as_slice());
        let mut jobs = Vec::<Job>::new();
        for record in csv_reader.deserialize() {
            let record: SlurmJob = record?;
            jobs.push(Job {
                id: record.job_id,
                name: record.job_name,
                owner: record.user,
                state: match record.state.as_str() {
                    "BOOT_FAIL" | "FAILED" | "NODE_FAIL" | "OUT_OF_MEMORY" | "TIMEOUT"
                    | "DEADLINE" => JobState::Failed,
                    "CANCELLED" => JobState::Suspended,
                    "COMPLETED" => JobState::Completed,
                    "PENDING" => JobState::Queuing,
                    "COMPLETING" => JobState::Completing,
                    "RUNNING" => JobState::Running,
                    _ => JobState::Unknown,
                },
                exit_status_code: record.exit_code.split(':').next().unwrap_or("0").parse()?,
                error_output: tokio::fs::read_to_string(format!("{}/STDERR", record.work_dir))
                    .await
                    .unwrap_or_default(),
                resource_used: TaskUsedResource {
                    cpu: record.ncpus,
                    avg_memory: record.ave_mem,
                    max_memory: record.mem,
                    storage: 0,
                    wall_time: record.elapsed,
                    cpu_time: record.cpu_time,
                    start_time: parse_time(&record.start),
                    end_time: parse_time(&record.end),
                    node: record.nnodes,
                },
            })
        }
        Ok(jobs)
    }
    async fn submit_job(&self, script_path: &str) -> anyhow::Result<String> {
        let out = {
            let mut path = PathBuf::new();
            path.push(self.base_path.as_str());
            path.push(script_path);
            if let Some(ssh_proxy) = self.ssh_proxy.clone() {
                let mut remote_path = PathBuf::new();
                remote_path.push(ssh_proxy.home_dir.as_str());
                remote_path.push(path.clone());
                let _ = tokio::process::Command::new("scp")
                    .arg("-P")
                    .arg(ssh_proxy.port.to_string())
                    .arg(path)
                    .arg(format!(
                        "{}@{}:{}",
                        ssh_proxy.username,
                        ssh_proxy.host,
                        remote_path.to_str().unwrap()
                    ))
                    .output()
                    .await?;
                let out = Command::new("ssh")
                    .arg("-p")
                    .arg(ssh_proxy.port.to_string())
                    .arg(format!("{}@{}", ssh_proxy.username, ssh_proxy.host))
                    .arg("cd")
                    .arg(remote_path.parent().unwrap())
                    .arg(";")
                    .arg("sbatch")
                    .arg(remote_path)
                    .output()
                    .await?;
                if !out.status.success() {
                    anyhow::bail!("Exit Status not 0. real: {}", out.status)
                }
                out
            } else {
                let out = Command::new("sbatch")
                    .arg(path.as_path())
                    .current_dir(path.parent().unwrap())
                    .output()
                    .await?;
                if !out.status.success() {
                    anyhow::bail!("Exit Status not 0. real: {}", out.status)
                }
                out
            }
        };
        Ok(String::from_utf8_lossy(&out.stdout)
            .replace("Submitted batch job ", "")
            .trim()
            .to_string())
    }
    async fn submit_job_script(&self, script_info: ScriptInfo) -> anyhow::Result<String> {
        let mut path = PathBuf::new();
        path.push(self.base_path.as_str());
        if !path.exists() {
            tokio::fs::create_dir_all(path.as_path()).await?;
        }
        path.push(script_info.path.as_str());
        tokio::fs::write(
            path,
            Self::gen_script(&self.base_path, &self.include_env, script_info.clone()),
        )
        .await?;
        self.submit_job(script_info.path.as_str()).await
    }
    async fn delete_job(&self, job_id: &str) -> anyhow::Result<()> {
        let out = if let Some(ssh_proxy) = self.ssh_proxy.clone() {
            Command::new("ssh")
                .arg("-p")
                .arg(ssh_proxy.port.to_string())
                .arg(format!("{}@{}", ssh_proxy.username, ssh_proxy.host))
                .arg("scancel")
                .arg(job_id)
                .output()
                .await?
        } else {
            Command::new("scancel").arg(job_id).output().await?
        };
        if !out.status.success() {
            anyhow::bail!("Exit Status not 0. real: {}", out.status)
        }
        Ok(())
    }
    async fn pause_job(&self, job_id: &str) -> anyhow::Result<()> {
        let out = if let Some(ssh_proxy) = self.ssh_proxy.clone() {
            Command::new("ssh")
                .arg("-p")
                .arg(ssh_proxy.port.to_string())
                .arg(format!("{}@{}", ssh_proxy.username, ssh_proxy.host))
                .arg("scontrol")
                .arg("suspend")
                .arg(job_id)
                .output()
                .await?
        } else {
            Command::new("scontrol").arg("suspend").arg(job_id).output().await?
        };
        if !out.status.success() {
            anyhow::bail!("Exit Status not 0. real: {}", out.status)
        }
        Ok(())
    }
    async fn continue_job(&self, job_id: &str) -> anyhow::Result<()> {
        let out = if let Some(ssh_proxy) = self.ssh_proxy.clone() {
            Command::new("ssh")
                .arg("-p")
                .arg(ssh_proxy.port.to_string())
                .arg(format!("{}@{}", ssh_proxy.username, ssh_proxy.host))
                .arg("scontrol")
                .arg("resume")
                .arg(job_id)
                .output()
                .await?
        } else {
            Command::new("scontrol").arg("resume").arg(job_id).output().await?
        };
        if !out.status.success() {
            anyhow::bail!("Exit Status not 0. real: {}", out.status)
        }
        Ok(())
    }
}

impl SlurmClient {
    fn gen_script(base_path: &str, include_env: &str, script_info: ScriptInfo) -> String {
        let header = "#!/bin/bash";
        let id = script_info.id.clone();
        let env: Vec<String> = script_info
            .environments
            .iter()
            .map(|(k, v)| format!("export {}={}", k, v))
            .collect();
        let env_string = env.join("\n");
        let touch = format!("echo -n \"{}\" > $SLURM_SUBMIT_DIR/.co.sig", script_info.id);
        let script = format!("{} {}", script_info.name, script_info.arguments.join(" "));
        let script = match script_info.std_in {
            agent_core::models::StdInKind::Text { text } => {
                format!("{script} << EOF\n{text}\nEOF")
            }
            agent_core::models::StdInKind::File { path } => {
                format!("{script} < {path}")
            }
            agent_core::models::StdInKind::Unknown => script,
        };
        let load_software = script_info.load_software;
        let resource_header = match script_info.requirements {
            None => String::default(),
            Some(x) => {
                let mut header = String::default();
                let mut cores = 1usize;
                header += match x.node_count {
                    Some(x) => {
                        if x <= 0 {
                            "#SBATCH --nodes=1\n".to_string()
                        } else {
                            cores = x as usize;
                            format!("#SBATCH --nodes={x}\n")
                        }
                    }
                    None => "#SBATCH --nodes=1\n".to_string(),
                }
                .as_str();
                header += match x.cpu_cores {
                    Some(x) => {
                        cores *= x;
                        format!("#SBATCH --ntasks-per-node={x}\n")
                    }
                    None => "#SBATCH --ntasks-per-node={x}\n".to_string(),
                }
                .as_str();
                header += match x.max_wall_time {
                    Some(x) => format!("#SBATCH --time={}\n", x),
                    None => String::default(),
                }
                .as_str();
                header += match x.max_cpu_time {
                    Some(x) => format!("#SBATCH --time={}\n", x / cores),
                    None => String::default(),
                }
                .as_str();
                header
            }
        };
        format!(
            r#"{header}
#SBATCH --output={base_path}/{id}/STDOUT
#SBATCH --error={base_path}/{id}/STDERR
cd $SLURM_SUBMIT_DIR
{resource_header}
{env_string}
{include_env}
{load_software}
mpirun -np $SLURM_NPROCS {script}
ec=$?
{touch}
exit $ec
"#
        )
    }
    pub fn new(
        base_path: String,
        include_env: String,
        ssh_proxy: Option<crate::config::SshProxyConfig>,
    ) -> Self {
        Self {
            base_path,
            include_env,
            ssh_proxy,
        }
    }
}

fn parse_time(time: &str) -> i64 {
    if time.eq("UNKNOWN") {
        return 0;
    }
    match chrono::DateTime::parse_from_rfc3339(time) {
        Ok(x) => x.timestamp(),
        Err(_) => 0,
    }
}
