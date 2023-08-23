use crate::dtos::{PreparePartialUploadFromNodeInstanceRequest, PreparePartialUploadResponse};
use agent_core::{
    models::{CollectFrom, CollectTo},
    services::IFileLoadService,
};
use alice_architecture::base_dto::ResponseBase;
use reqwest::multipart::{Form, Part};
use std::sync::Arc;

pub struct FileLoadService {
    base_path: String,
    http_client: Arc<reqwest::Client>,
    base_url: String,
    ssh_proxy: Option<crate::config::SshProxyConfig>,
}

#[async_trait::async_trait]
impl IFileLoadService for FileLoadService {
    async fn load_file(&self, parent_id: &str, from: &CollectFrom) -> anyhow::Result<String> {
        let mut p = std::path::PathBuf::new();
        if let Some(ssh_proxy) = &self.ssh_proxy {
            p.push(ssh_proxy.home_dir.as_str());
            p.push(self.base_path.as_str());
            p.push(parent_id);
            let mut p_local = std::path::PathBuf::new();
            p.push(self.base_path.as_str());
            p.push(parent_id);
            match from {
                CollectFrom::FileOut { path } => {
                    p.push(path);
                    p_local.push(path);
                    log::trace!("Load file from {}", p.to_string_lossy());
                    let mut cmd: tokio::process::Command = tokio::process::Command::new("scp");
                    cmd.arg("-r");
                    cmd.arg(format!("-P {}", ssh_proxy.port));
                    cmd.arg(format!(
                        "{}@{}:{}",
                        ssh_proxy.username,
                        ssh_proxy.host,
                        p.to_string_lossy()
                    ));
                    cmd.arg(p_local.clone());
                    cmd.spawn()?.wait().await?;
                    Ok(tokio::fs::read_to_string(p_local).await?)
                }
                CollectFrom::Stdout => {
                    p.push("STDOUT");
                    p_local.push("STDOUT");
                    let mut cmd = tokio::process::Command::new("scp");
                    cmd.arg("-r");
                    cmd.arg(format!("-P {}", ssh_proxy.port));
                    cmd.arg(format!(
                        "{}@{}:{}",
                        ssh_proxy.username,
                        ssh_proxy.host,
                        p.to_string_lossy()
                    ));
                    cmd.arg(p_local.clone());
                    cmd.spawn()?.wait().await?;
                    Ok(tokio::fs::read_to_string(p_local).await?)
                }
                CollectFrom::Stderr => {
                    p.push("STDERR");
                    p_local.push("STDERR");
                    let mut cmd = tokio::process::Command::new("scp");
                    cmd.arg("-r");
                    cmd.arg(format!("-P {}", ssh_proxy.port));
                    cmd.arg(format!(
                        "{}@{}:{}",
                        ssh_proxy.username,
                        ssh_proxy.host,
                        p.to_string_lossy()
                    ));
                    cmd.arg(p_local.clone());
                    cmd.spawn()?.wait().await?;
                    Ok(tokio::fs::read_to_string(p_local).await?)
                }
            }
        } else {
            p.push(self.base_path.as_str());
            p.push(parent_id);
            match from {
                CollectFrom::FileOut { path } => {
                    p.push(path);
                    log::trace!("Load file from {}", p.to_string_lossy());
                    Ok(tokio::fs::read_to_string(p).await?)
                }
                CollectFrom::Stdout => {
                    p.push("STDOUT");
                    Ok(tokio::fs::read_to_string(p).await?)
                }
                CollectFrom::Stderr => {
                    p.push("STDERR");
                    Ok(tokio::fs::read_to_string(p).await?)
                }
            }
        }
    }
    async fn save_file(
        &self,
        parent_id: uuid::Uuid,
        output: &str,
        to: &CollectTo,
    ) -> anyhow::Result<()> {
        match to {
            CollectTo::File { id, path } => {
                let file = output.as_bytes().to_vec();
                let file_hash = blake3::hash(file.as_slice()).to_hex().to_uppercase();
                let json = PreparePartialUploadFromNodeInstanceRequest {
                    file_name: path.clone(),
                    hash_algorithm: "blake3".to_string(),
                    hash: file_hash.clone(),
                    size: file.len() as u64,
                    count: 1,
                    node_instance_uuid: parent_id,
                    file_metadata_id: Some(*id),
                };
                let url = url::Url::parse(self.base_url.as_str())
                    .unwrap()
                    .join("file-storage/PreparePartialUploadFromNodeInstance")
                    .unwrap();
                let response: ResponseBase<PreparePartialUploadResponse> =
                    self.http_client.post(url).json(&json).send().await?.json().await?;
                let response = response.content.unwrap();
                if response.result == crate::dtos::PreparePartialUploadResponseResult::FlashUpload {
                    return Ok(());
                }
                let part = match Part::bytes(file)
                    .file_name(path.clone())
                    .mime_str("application/octet-stream")
                {
                    Ok(x) => x,
                    Err(e) => {
                        anyhow::bail!("Unable to upload, because of {e}");
                    }
                };
                let from = Form::new()
                    .text("nth", "0")
                    .text("file_metadata_id", response.id.to_string())
                    .part("bin", part);
                let url = url::Url::parse(self.base_url.as_str())
                    .unwrap()
                    .join("file-storage/PartialUpload")
                    .unwrap();
                match self.http_client.post(url).multipart(from).send().await {
                    Ok(_) => {}
                    Err(e) => {
                        anyhow::bail!("Unable to upload, because of {e}");
                    }
                }
            }
            CollectTo::Text { id } => {
                let url = url::Url::parse(self.base_url.as_str())
                    .unwrap()
                    .join("text-storage/upload")
                    .unwrap();
                match self
                    .http_client
                    .post(url)
                    .json(&serde_json::json!({
                        "key": id,
                        "value": output
                    }))
                    .send()
                    .await
                {
                    Ok(_) => {}
                    Err(e) => {
                        anyhow::bail!("Unable to upload, because of {e}");
                    }
                }
            }
        }
        Ok(())
    }
}

impl FileLoadService {
    pub fn new(
        base_path: String,
        http_client: Arc<reqwest::Client>,
        base_url: String,
        ssh_proxy: Option<crate::config::SshProxyConfig>,
    ) -> Self {
        Self {
            base_path,
            http_client,
            base_url,
            ssh_proxy,
        }
    }
}
