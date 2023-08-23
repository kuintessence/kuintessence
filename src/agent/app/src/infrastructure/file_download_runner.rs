use agent_core::{
    models::FileTransferCommand,
    services::{IDownloadSender, IRunJobService},
};
use alice_architecture::hosting::IBackgroundService;
use reqwest::Client;
use std::sync::Arc;
use tokio::{
    fs::File,
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tracing::Instrument;

pub struct FileDownloadRunner {
    save_dir: String,
    receiver: flume::Receiver<FileTransferCommand>,
    http_client: Arc<reqwest::Client>,
    base_url: String,
    run_task: Arc<dyn IRunJobService + Send + Sync>,
    block_size: u64,
    ssh_proxy: Option<crate::config::SshProxyConfig>,
}

#[async_trait::async_trait]
impl IBackgroundService for FileDownloadRunner {
    async fn run(&self) {
        loop {
            let base_url = self.base_url.clone();
            match self.receiver.recv_async().await {
                Ok(command) => {
                    if let agent_core::models::FileTransferStatus::Start = command.status {
                        let task_file = command.task_file.unwrap();
                        let run_task = self.run_task.clone();
                        let http_client = self.http_client.clone();
                        let max_block_length = self.block_size;
                        let save_dir = self.save_dir.clone();
                        let ssh_proxy = self.ssh_proxy.clone();
                        tokio::spawn(
                            async move {
                                let task = async {
                                    let mut path = std::path::PathBuf::new();
                                    path.push(save_dir.as_str());
                                    path.push(command.parent_id.to_string().as_str());
                                    path.push(task_file.file_name.as_str());
                                    if !path.exists() {
                                        log::trace!("File {} created directory {}.", task_file.metadata_id, path.to_string_lossy());
                                        tokio::fs::create_dir_all(path.parent().unwrap())
                                            .await
                                            .unwrap();
                                    }
                                    log::debug!(
                                        "Starting download file {} into {}.",
                                        task_file.metadata_id,
                                        task_file.file_name
                                    );
                                    log::trace!("Download file info: {task_file:#?}");
                                    if task_file.is_generated {
                                        match tokio::fs::write(path, task_file.text.as_str()).await {
                                            Ok(()) =>  {},
                                            Err(e) => {
                                                log::error!("{}", e);
                                                anyhow::bail!(e);
                                            }
                                        };
                                        return Ok(());
                                    }
                                    let url = url::Url::parse(base_url.as_str())
                                    .unwrap()
                                    .join(format!("file-storage/RangelyDownloadFile/{}", task_file.metadata_id.to_string().as_str()).as_str())
                                    .unwrap();
                                    log::trace!("File {} is downloading from url \"{}\" .", task_file.metadata_id, url);
                                    let file_length = tokio::select! {
                                        x = http_client.head(url.clone()).send() => {
                                            match x {
                                                Ok(x) => {
                                                    let headers = x.headers();
                                                    let content_length = headers.get("Content-Length");
                                                    match content_length {
                                                        Some(x) => {
                                                            match x.to_str() {
                                                                Ok(x) => {
                                                                    match x.parse() {
                                                                        Ok(x) => {
                                                                            x
                                                                        }
                                                                        Err(_) => 0
                                                                    }
                                                                }
                                                                Err(_) => 0
                                                            }
                                                        }
                                                        None => 0
                                                    }
                                                },
                                                Err(_) => {
                                                    0
                                                }
                                            }
                                        }
                                        _ = tokio::time::sleep(tokio::time::Duration::from_secs(5)) => {
                                            0
                                        }
                                    };
                                    if file_length == 0 {
                                        let response =
                                        match http_client.get(url).send().await {
                                            Ok(x) => x,
                                            Err(e) => {
                                                log::error!("{}", e);
                                                anyhow::bail!(e);
                                            }
                                        };
                                        log::trace!("File {} download finished.", task_file.metadata_id);
                                        let mut file = match tokio::fs::File::create(path).await {
                                            Ok(x) => x,
                                            Err(e) => {
                                                log::error!("{}", e);
                                                anyhow::bail!(e);
                                            }
                                        };
                                        match tokio::io::copy(
                                            &mut response.bytes().await.unwrap().as_ref(),
                                            &mut file,
                                        )
                                        .await
                                        {
                                            Ok(_) => {}
                                            Err(e) => {
                                                log::error!("{}", e);
                                                anyhow::bail!(e);
                                            }
                                        };
                                        log::debug!(
                                            "File {} was writed into {}.",
                                            task_file.metadata_id,
                                            task_file.file_name
                                        );
                                    } else {
                                        let file = match tokio::fs::File::create(path).await {
                                            Ok(x) => x,
                                            Err(e) => {
                                                log::error!("{}", e);
                                                anyhow::bail!(e);
                                            }
                                        };
                                        match file.set_len(file_length).await {
                                            Ok(()) => {},
                                            Err(e) => {
                                                log::error!("{}", e);
                                                anyhow::bail!(e);
                                            }
                                        };
                                        let (block_length, block_count) = {
                                            if file_length > max_block_length {
                                                if file_length % max_block_length != 0 {
                                                    (max_block_length, file_length / max_block_length + 1)
                                                }else{(max_block_length, file_length / max_block_length)}
                                            } else {
                                                (file_length, 1)
                                            }
                                        };
                                        let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(16));
                                        let mut tasks = vec![];
                                        for i in 0..block_count {
                                            let url = url.clone();
                                            let http_client = http_client.clone();
                                            let writer = file.try_clone().await.unwrap();
                                            let permit = semaphore.clone().acquire_owned().await.unwrap();
                                            let task = tokio::spawn(async move {
                                                let task = download_task(
                                                    block_count, file_length, i, block_length, http_client, url, writer,
                                                ).await;
                                                drop(permit);
                                                task
                                            });
                                            tasks.push(task);
                                        }
                                        for task in tasks {
                                            match task.await {
                                                Ok(_) => {}
                                                Err(e) => {
                                                    log::error!("Cannot download File {} to Node {}, because of {e}", task_file.metadata_id, command.parent_id);
                                                    anyhow::bail!(e);
                                                }
                                            }
                                        }
                                    }
                                    Ok(())
                                };
                                match task.await {
                                    Ok(_) => {
                                        if let Some(ssh_proxy) = ssh_proxy {
                                            let mut remote_path = std::path::PathBuf::new();
                                            remote_path.push(ssh_proxy.home_dir);
                                            remote_path.push(save_dir.as_str());
                                            remote_path.push(command.parent_id.to_string().as_str());
                                            remote_path.push(task_file.file_name.as_str());
                                            let mut path = std::path::PathBuf::new();
                                            path.push(save_dir.as_str());
                                            path.push(command.parent_id.to_string().as_str());
                                            path.push(task_file.file_name.as_str());
                                            let mut cmd = tokio::process::Command::new("scp");
                                            cmd.arg("-P");
                                            cmd.arg(ssh_proxy.port.to_string());
                                            cmd.arg(path);
                                            cmd.arg(format!("{}@{}:{}", ssh_proxy.username, ssh_proxy.host, remote_path.to_string_lossy()));
                                            match cmd.spawn() {
                                                Ok(mut x) => {
                                                    match x.wait().await {
                                                        Ok(x) => {
                                                            if !x.success() {
                                                                match run_task.fail_job(task_file.related_task_body.to_string().as_str(), format!("Unable to download file {}, because of ssh transport not success.", task_file.metadata_id).as_str()).await {
                                                                    Ok(()) => {}
                                                                    Err(e) => {
                                                                        log::error!("{}", e);
                                                                    }
                                                                };
                                                            }
                                                        }
                                                        Err(e) => {
                                                            match run_task.fail_job(task_file.related_task_body.to_string().as_str(), format!("Unable to download file {}, because of {e}", task_file.metadata_id).as_str()).await {
                                                                Ok(()) => {}
                                                                Err(e) => {
                                                                    log::error!("{}", e);
                                                                }
                                                            };
                                                        }
                                                    }
                                                }
                                                Err(e) => {
                                                    match run_task.fail_job(task_file.related_task_body.to_string().as_str(), format!("Unable to download file {}, because of {e}", task_file.metadata_id).as_str()).await {
                                                        Ok(()) => {}
                                                        Err(e) => {
                                                            log::error!("{}", e);
                                                        }
                                                    };
                                                }
                                            }
                                        }
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
                                        tokio::time::sleep(tokio::time::Duration::from_millis(sleep_time)).await;
                                        match run_task.run_job(task_file.id.to_string().as_str()).await {
                                            Ok(()) => {}
                                            Err(e) => {
                                                log::error!("{}", e);
                                            }
                                        };
                                    }
                                    Err(e) => {
                                        match run_task.fail_job(task_file.related_task_body.to_string().as_str(), format!("Unable to download file {}, because of {e}", task_file.metadata_id).as_str()).await {
                                            Ok(()) => {}
                                            Err(e) => {
                                                log::error!("{}", e);
                                            }
                                        };
                                    }
                                }
                            }
                            .instrument(tracing::trace_span!("file_download_runner")),
                        );
                    }
                }
                Err(e) => log::error!("{} 2", e),
            }
        }
    }
}

impl FileDownloadRunner {
    pub fn new(
        save_dir: String,
        receiver: flume::Receiver<FileTransferCommand>,
        http_client: Arc<reqwest::Client>,
        base_url: String,
        run_task: Arc<dyn IRunJobService + Send + Sync>,
        ssh_proxy: Option<crate::config::SshProxyConfig>,
    ) -> Self {
        Self {
            save_dir,
            http_client,
            receiver,
            base_url,
            run_task,
            block_size: 16777216,
            ssh_proxy,
        }
    }
}

pub struct DownloadSender {
    sender: Arc<flume::Sender<FileTransferCommand>>,
    receiver: flume::Receiver<FileTransferCommand>,
}

#[async_trait::async_trait]
impl IDownloadSender for DownloadSender {
    async fn send(&self, command: FileTransferCommand) -> anyhow::Result<()> {
        Ok(self.sender.send(command)?)
    }
}

impl DownloadSender {
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

async fn download_task(
    block_count: u64,
    file_length: u64,
    block: u64,
    block_length: u64,
    http_client: Arc<Client>,
    url: url::Url,
    mut writer: File,
) -> anyhow::Result<()> {
    let real_block_length = if block == (block_count - 1) {
        file_length - block * block_length - 1
    } else {
        block_length - 1
    };
    let start = block * block_length;
    let end = block * block_length + real_block_length;
    let response = {
        let mut response = bytes::Bytes::new();
        for i in 1..=4 {
            tokio::select! {
                x = http_client.get(url.clone()).header("Range", format!("bytes={}-{}", start, end)).send() => {
                    match x {
                        Ok(x) => match x.bytes().await {
                            Ok(x) => {
                                response = x;
                                break;
                            },
                            Err(e) => {
                                if i == 4 {
                                    anyhow::bail!(e);
                                }
                                continue;
                            }
                        },
                        Err(e) => {
                            if i == 4 {
                                anyhow::bail!(e);
                            }
                            continue;
                        }
                    };
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_millis(30000)) => {
                    if i == 4 {
                        anyhow::bail!("timeout");
                    }
                    continue;
                }
            }
        }
        response
    };
    match writer.seek(std::io::SeekFrom::Start(block * block_length)).await {
        Ok(_) => {}
        Err(e) => {
            anyhow::bail!(e);
        }
    }
    match writer.write_all_buf(&mut response.as_ref()).await {
        Ok(_) => {}
        Err(e) => {
            anyhow::bail!(e);
        }
    }
    Ok(())
}
