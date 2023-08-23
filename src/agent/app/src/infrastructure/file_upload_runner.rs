use crate::dtos::{
    PreparePartialUploadFromNodeInstanceRequest, PreparePartialUploadResponse,
    PreparePartialUploadResponseResult,
};
use agent_core::{
    models::FileTransferCommand,
    services::{IRunJobService, IUploadSender},
};
use alice_architecture::{base_dto::ResponseBase, hosting::IBackgroundService};
use reqwest::multipart::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tracing::Instrument;

pub struct FileUploadRunner {
    save_dir: String,
    receiver: flume::Receiver<FileTransferCommand>,
    run_task: Arc<dyn IRunJobService + Send + Sync>,
    base_url: String,
    client: Arc<reqwest::Client>,
    block_size: u64,
    ssh_proxy: Option<crate::config::SshProxyConfig>,
}

#[async_trait::async_trait]
impl IBackgroundService for FileUploadRunner {
    async fn run(&self) {
        loop {
            match self.receiver.recv_async().await {
                Ok(command) => {
                    let client = self.client.clone();
                    let base_url = self.base_url.clone();
                    let save_dir = self.save_dir.clone();
                    let max_block_length = self.block_size;
                    let run_task = self.run_task.clone();
                    let ssh_proxy = self.ssh_proxy.clone();
                    if let agent_core::models::FileTransferStatus::Start = command.status {
                        tokio::spawn(
                            async move {
                                let task_file = command.task_file.unwrap();
                                let task = async {
                                    let mut file_path = std::path::PathBuf::new();
                                    let task_file = task_file.clone();
                                    log::debug!(
                                        "Starting upload file {} into {}.",
                                        task_file.metadata_id,
                                        task_file.file_name
                                    );
                                    log::trace!("Upload file info: {task_file:#?}");
                                    file_path.push(save_dir);
                                    file_path.push(command.parent_id.to_string());
                                    file_path.push(task_file.file_name.clone());
                                    log::trace!(
                                        "File {} read from {}",
                                        task_file.id,
                                        task_file.file_name
                                    );
                                    if let Some(ssh_proxy) = ssh_proxy {
                                        let mut remote_path = std::path::PathBuf::new();
                                        remote_path.push(ssh_proxy.home_dir);
                                        remote_path.push(file_path.clone());
                                        let mut cmd = tokio::process::Command::new("scp");
                                        cmd.arg("-r");
                                        cmd.arg(format!("-P {}", ssh_proxy.port));
                                        cmd.arg(format!(
                                            "{}@{}:{}",
                                            ssh_proxy.username, ssh_proxy.host, remote_path.to_string_lossy()
                                        ));
                                        cmd.arg(file_path.clone());
                                        let _ = cmd.spawn()?.wait().await?;
                                    }
                                    let mut file =
                                        match tokio::fs::File::open(file_path.as_path()).await {
                                            Ok(x) => x,
                                            Err(e) => {
                                                if task_file.is_optional {
                                                    log::debug!(
                                                        "File {} is not existed, but is optional.",
                                                        task_file.metadata_id
                                                    );
                                                    return Ok(());
                                                } else {
                                                    log::error!("{e}");
                                                    anyhow::bail!(e);
                                                }
                                            }
                                        };
                                    let file_hash = match get_hash(&mut file).await {
                                        Ok(x) => x,
                                        Err(e) => {
                                            log::error!("{e}");
                                            anyhow::bail!(e);
                                        }
                                    };
                                    let file_length = match file.metadata().await {
                                        Ok(x) => x.len(),
                                        Err(e) => {
                                            log::error!("{e}");
                                            anyhow::bail!(e);
                                        }
                                    };
                                    let (block_length, block_count) = {
                                        if file_length > max_block_length {
                                            if file_length % max_block_length != 0 {
                                                (
                                                    max_block_length,
                                                    file_length / max_block_length + 1,
                                                )
                                            } else {
                                                (max_block_length, file_length / max_block_length)
                                            }
                                        } else {
                                            (file_length, 1u64)
                                        }
                                    };
                                    let json = PreparePartialUploadFromNodeInstanceRequest {
                                        file_name: task_file.file_name.clone(),
                                        hash_algorithm: "blake3".to_string(),
                                        hash: file_hash.clone(),
                                        size: file_length,
                                        count: block_count,
                                        node_instance_uuid: command.parent_id,
                                        file_metadata_id: Some(task_file.metadata_id),
                                    };
                                    let url = url::Url::parse(base_url.as_str())
                                        .unwrap()
                                        .join("file-storage/PreparePartialUploadFromNodeInstance")
                                        .unwrap();
                                    let sleep_time = {
                                        let sleep_time = rand::random::<u8>() as u64 / 10;
                                        if sleep_time > 20 {
                                            sleep_time - 10
                                        } else if sleep_time == 0 {
                                            1
                                        } else {
                                            sleep_time
                                        }
                                    };
                                    sleep(sleep_time).await;
                                    let response: ResponseBase<PreparePartialUploadResponse> =
                                        match http_post(&client, &url, &json, 10, 5000).await {
                                            Ok(x) => match x.json().await {
                                                Ok(x) => x,
                                                Err(e) => {
                                                    log::error!("{e}");
                                                    anyhow::bail!(e);
                                                }
                                            },
                                            Err(e) => {
                                                log::error!("{e}");
                                                anyhow::bail!(e);
                                            }
                                        };
                                    let response = match response.content {
                                        Some(x) => x,
                                        None => {
                                            log::error!("Upload url is null.");
                                            anyhow::bail!("Upload url is null.");
                                        }
                                    };
                                    if response.result
                                        != PreparePartialUploadResponseResult::FlashUpload
                                    {
                                        let semaphore =
                                            std::sync::Arc::new(tokio::sync::Semaphore::new(16));
                                        let mut tasks = vec![];
                                        for i in 0..block_count {
                                            let url = url.clone();
                                            let http_client = client.clone();
                                            let file = file.try_clone().await.unwrap();
                                            let permit =
                                                semaphore.clone().acquire_owned().await.unwrap();
                                            let file_name = task_file.file_name.clone();
                                            let file_id = response.id.to_string();
                                            tasks.push(tokio::spawn(async move {
                                                let result = http_post_file(
                                                    http_client,
                                                    url,
                                                    5,
                                                    30000,
                                                    file_name,
                                                    file_id,
                                                    file,
                                                    i,
                                                    block_count,
                                                    block_length,
                                                    file_length,
                                                )
                                                .await;
                                                drop(permit);
                                                result
                                            }));
                                        }
                                        for task in tasks {
                                            match task.await {
                                                Ok(_) => {}
                                                Err(e) => {
                                                    log::error!("{e}");
                                                    anyhow::bail!(e);
                                                }
                                            }
                                        }
                                    }
                                    Ok(())
                                };
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
                                };
                                sleep(sleep_time).await;
                                match task.await {
                                    Ok(()) => match run_task
                                        .complete_job(command.id.to_string().as_str())
                                        .await
                                    {
                                        Ok(()) => {}
                                        Err(e) => log::error!("{e}"),
                                    },
                                    Err(e) => {
                                        match run_task.fail_job(task_file.related_task_body.to_string().as_str(),
                                        format!("Cannot upload File {} to Node {} when uploading block, because of {e}",
                                        task_file.id,
                                        command.parent_id).as_str()).await {
                                            Ok(()) => {}
                                            Err(e) => log::error!("{e}")
                                        }
                                    }
                                }
                            }
                            .instrument(tracing::trace_span!("file_upload_runner")),
                        );
                    };
                }
                Err(e) => log::error!("{}", e),
            }
        }
    }
}

impl FileUploadRunner {
    pub fn new(
        save_dir: String,
        base_url: String,
        receiver: flume::Receiver<FileTransferCommand>,
        run_task: Arc<dyn IRunJobService + Send + Sync>,
        client: Arc<reqwest::Client>,
        ssh_proxy: Option<crate::config::SshProxyConfig>,
    ) -> Self {
        Self {
            save_dir,
            receiver,
            run_task,
            base_url,
            client,
            block_size: 1024 * 512,
            ssh_proxy,
        }
    }
}

pub struct UploadSender {
    sender: Arc<flume::Sender<FileTransferCommand>>,
    receiver: flume::Receiver<FileTransferCommand>,
}

#[async_trait::async_trait]
impl IUploadSender for UploadSender {
    async fn send(&self, command: FileTransferCommand) -> anyhow::Result<()> {
        Ok(self.sender.send(command)?)
    }
}

impl UploadSender {
    pub fn new() -> Self {
        let (sender, receiver): (
            flume::Sender<FileTransferCommand>,
            flume::Receiver<FileTransferCommand>,
        ) = flume::unbounded();
        Self {
            sender: Arc::from(sender),
            receiver,
        }
    }

    pub fn get_receiver(&self) -> flume::Receiver<FileTransferCommand> {
        self.receiver.clone()
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

async fn http_post<'a, REQ>(
    client: &Arc<reqwest::Client>,
    url: &url::Url,
    body: &REQ,
    max_times: u64,
    timeout: u64,
) -> anyhow::Result<reqwest::Response>
where
    REQ: serde::Serialize,
{
    let mut times = 1u64;
    loop {
        tokio::select! {
            x = client.post(url.clone()).json(&body).send() => {
                match x {
                    Ok(x) => {
                        if let Err(e) = x.error_for_status_ref() {
                            times += 1;
                            if times == max_times {
                                return Err(anyhow::anyhow!(e));
                            }
                            sleep(times).await;
                            continue;
                        }
                        break Ok(x);
                    },
                    Err(e) => {
                        times += 1;
                        if times == max_times {
                            return Err(anyhow::anyhow!(e));
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

async fn get_hash(file: &mut tokio::fs::File) -> Result<String, impl std::error::Error> {
    let mut hasher = blake3::Hasher::new();
    let mut file = file.try_clone().await?;
    let mut buffer = [0; 65536];
    loop {
        match file.read(&mut buffer).await {
            Ok(0) => return Ok(hasher.finalize().to_hex().to_uppercase()),
            Ok(n) => {
                hasher.update(&buffer[..n]);
            }
            Err(ref e) if e.kind() == tokio::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
}

async fn http_post_file(
    client: Arc<reqwest::Client>,
    url: url::Url,
    max_times: u64,
    timeout: u64,
    file_name: String,
    file_id: String,
    mut body: tokio::fs::File,
    index: u64,
    block_count: u64,
    block_length: u64,
    file_length: u64,
) -> anyhow::Result<reqwest::Response> {
    let mut times = 1u64;
    let buffer = {
        let real_block_length = if index == (block_count - 1) {
            file_length - index * block_length - 1
        } else {
            block_length - 1
        };
        body.seek(std::io::SeekFrom::Start(index * block_length)).await?;
        let mut buffer = vec![0; real_block_length as usize];
        body.read_exact(&mut buffer).await?;
        buffer
    };
    loop {
        let part = match Part::bytes(buffer.clone())
            .file_name(file_name.clone())
            .mime_str("application/octet-stream")
        {
            Ok(x) => x,
            Err(e) => {
                times += 1;
                if times == max_times {
                    return Err(anyhow::anyhow!(e));
                }
                sleep(times).await;
                continue;
            }
        };
        let form = Form::new()
            .text("nth", index.to_string())
            .text("file_metadata_id", file_id.clone())
            .part("bin", part);
        tokio::select! {
            x = client.post(url.clone()).multipart(form).send() => {
                match x {
                    Ok(x) => {
                        if let Err(e) = x.error_for_status_ref() {
                            times += 1;
                            if times == max_times {
                                return Err(anyhow::anyhow!(e));
                            }
                            sleep(times).await;
                            continue;
                        }
                        break Ok(x);
                    },
                    Err(e) => {
                        times += 1;
                        if times == max_times {
                            return Err(anyhow::anyhow!(e));
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
