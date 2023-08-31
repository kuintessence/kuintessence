use alice_architecture::utils::*;
use alice_infrastructure::config::CommonConfig;
use getset::Getters;
use std::collections::HashMap;

#[derive(Default, Clone, Deserialize, Debug, Getters)]
#[getset(get = "pub")]
pub struct CoConfig {
    #[serde(default)]
    common: CommonConfig,
    #[serde(default)]
    file_system: FileSystemConfig,
    #[serde(default)]
    http_client: HttpClientConfig,
    #[serde(default)]
    default_storage_server_id: Uuid,
    #[serde(default = "default_bill_topic")]
    bill_topic: String,
    #[serde(default = "default_co_repo_domain")]
    co_repo_domain: String,
}

fn default_co_repo_domain() -> String {
    "https://co-repo.lab.supercomputing.link".to_string()
}

fn default_bill_topic() -> String {
    "bill-dev".to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone, Getters)]
#[getset(get = "pub")]
pub struct HttpClientConfig {
    #[serde(default = "Default::default")]
    http_header: HashMap<String, String>,
    #[serde(default = "HttpClientConfig::default_user_agent")]
    user_agent: String,
}

impl Default for HttpClientConfig {
    fn default() -> Self {
        Self {
            http_header: Default::default(),
            user_agent: Self::default_user_agent(),
        }
    }
}

impl HttpClientConfig {
    pub fn default_user_agent() -> String {
        "COS/1.0".to_string()
    }
}

#[derive(Clone, Deserialize, Debug, Getters)]
#[getset(get = "pub")]
pub struct FileSystemConfig {
    #[serde(default = "FileSystemConfig::default_cache_base")]
    cache_base: String,
    #[serde(default)]
    realtime: RealtimeConfig,
    #[serde(default)]
    snapshot: SnapshotConfig,
    #[serde(default)]
    file_move: FileMoveConfig,
    #[serde(default)]
    multipart: MultipartConfig,
}

#[derive(Clone, Deserialize, Debug, Getters)]
#[getset(get = "pub")]
pub struct MultipartConfig {
    #[serde(default = "MultipartConfig::default_exp_msecs")]
    exp_msecs: i64,
}

#[derive(Clone, Deserialize, Debug, Getters)]
#[getset(get = "pub")]
pub struct FileMoveConfig {
    #[serde(default = "FileMoveConfig::default_exp_msecs")]
    exp_msecs: i64,
    #[serde(default = "FileMoveConfig::default_file_upload_topic")]
    file_upload_topic: String,
}

#[derive(Clone, Deserialize, Debug, Getters)]
#[getset(get = "pub")]
pub struct RealtimeConfig {
    #[serde(default = "RealtimeConfig::default_request_topic")]
    request_topic: String,
    #[serde(default = "RealtimeConfig::default_ws_topic")]
    ws_topic: String,
    #[serde(default = "RealtimeConfig::default_exp_msecs")]
    exp_msecs: i64,
}

#[derive(Clone, Deserialize, Debug, Getters)]
#[getset(get = "pub")]
pub struct SnapshotConfig {
    #[serde(default = "SnapshotConfig::default_exp_msecs")]
    exp_msecs: i64,
}

impl SnapshotConfig {
    fn default_exp_msecs() -> i64 {
        24 * 60 * 60 * 1000
    }
}

impl Default for SnapshotConfig {
    fn default() -> Self {
        Self {
            exp_msecs: Self::default_exp_msecs(),
        }
    }
}

impl MultipartConfig {
    fn default_exp_msecs() -> i64 {
        24 * 60 * 60 * 1000
    }
}

impl Default for MultipartConfig {
    fn default() -> Self {
        Self {
            exp_msecs: Self::default_exp_msecs(),
        }
    }
}

impl FileMoveConfig {
    fn default_exp_msecs() -> i64 {
        24 * 60 * 60 * 1000
    }
    fn default_file_upload_topic() -> String {
        "run-file-upload".to_string()
    }
}

impl Default for FileMoveConfig {
    fn default() -> Self {
        Self {
            exp_msecs: Self::default_exp_msecs(),
            file_upload_topic: Self::default_file_upload_topic(),
        }
    }
}

impl RealtimeConfig {
    fn default_request_topic() -> String {
        "realtime-request".to_string()
    }
    fn default_ws_topic() -> String {
        "ws-send-to-client".to_string()
    }
    fn default_exp_msecs() -> i64 {
        24 * 60 * 60 * 1000
    }
}

impl Default for RealtimeConfig {
    fn default() -> Self {
        Self {
            request_topic: Self::default_request_topic(),
            ws_topic: Self::default_ws_topic(),
            exp_msecs: Self::default_exp_msecs(),
        }
    }
}

impl Default for FileSystemConfig {
    fn default() -> Self {
        Self {
            cache_base: Self::default_cache_base(),
            realtime: RealtimeConfig::default(),
            snapshot: SnapshotConfig::default(),
            file_move: FileMoveConfig::default(),
            multipart: MultipartConfig::default(),
        }
    }
}

impl FileSystemConfig {
    fn default_cache_base() -> String {
        "base_dir".to_string()
    }
}
