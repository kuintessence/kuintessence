use alice_infrastructure::config::CommonConfig;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Default, Clone, Deserialize, Debug)]
pub struct CoConfig {
    #[serde(default, flatten)]
    pub common: CommonConfig,
    #[serde(default)]
    pub default_storage_server_id: Uuid,
    #[serde(default = "default_bill_topic")]
    pub bill_topic: String,
    #[serde(default = "default_co_repo_domain")]
    pub co_repo_domain: String,
    #[serde(default)]
    pub internal_topics: InternalTopics,
    #[serde(default)]
    pub web_socket: WebSocketConfig,
}

#[derive(Clone, Deserialize, Debug)]
pub struct InternalTopics {
    #[serde(default = "InternalTopics::default_web_socket")]
    pub web_socket: String,
    #[serde(default = "InternalTopics::default_file_upload")]
    pub file_upload: String,
    #[serde(default = "InternalTopics::default_status")]
    pub status: String,
    #[serde(default)]
    pub ws_messages: WebSocketMessageTopics,
}

impl InternalTopics {
    fn default_web_socket() -> String {
        "web-socket".to_string()
    }
    fn default_file_upload() -> String {
        "file-upload".to_string()
    }
    fn default_status() -> String {
        "node-status".to_string()
    }
}

impl Default for InternalTopics {
    fn default() -> Self {
        Self {
            web_socket: Default::default(),
            file_upload: Self::default_file_upload(),
            status: Self::default_status(),
            ws_messages: Default::default(),
        }
    }
}

#[derive(Clone, Deserialize, Debug)]
pub struct WebSocketMessageTopics {
    #[serde(default = "WebSocketMessageTopics::default_realtime")]
    pub realtime: String,
}

impl WebSocketMessageTopics {
    fn default_realtime() -> String {
        "realtime".to_string()
    }
}

impl Default for WebSocketMessageTopics {
    fn default() -> Self {
        Self {
            realtime: Self::default_realtime(),
        }
    }
}

#[derive(Clone, Deserialize, Debug)]
pub struct WebSocketConfig {
    pub keep_alive: u64,
}

impl WebSocketConfig {
    pub fn default_keep_alive() -> u64 {
        20 * 60
    }
}

impl Default for WebSocketConfig {
    fn default() -> Self {
        Self {
            keep_alive: Self::default_keep_alive(),
        }
    }
}

fn default_co_repo_domain() -> String {
    "https://co-repo.lab.supercomputing.link".to_string()
}

fn default_bill_topic() -> String {
    "bill-dev".to_string()
}
