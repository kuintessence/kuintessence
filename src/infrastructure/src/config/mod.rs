use getset::Getters;
use serde::*;
use std::collections::HashSet;

#[derive(Default, Deserialize, Clone, Debug, Getters)]
#[getset(get = "pub")]
pub struct CommonConfig {
    #[cfg(feature = "telemetry")]
    #[serde(default)]
    telemetry: crate::telemetry::TelemetryConfig,
    #[serde(default)]
    db: DatabaseConfig,
    #[serde(default)]
    host: HostConfig,
    #[serde(default)]
    mq: MessageQueueConfig,
    #[serde(default)]
    redis: RedisConfig,
    #[serde(default)]
    jwt: JwtValidationConfig,
}

#[derive(Deserialize, Clone, Debug, Getters)]
#[getset(get = "pub")]
pub struct JwtValidationConfig {
    #[serde(default = "JwtValidationConfig::default_required_spec_claims")]
    required_spec_claims: HashSet<String>,
    #[serde(default = "JwtValidationConfig::default_leeway")]
    leeway: u64,
    #[serde(default = "JwtValidationConfig::default_validate_exp")]
    validate_exp: bool,
    #[serde(default = "JwtValidationConfig::default_validate_nbf")]
    validate_nbf: bool,
    #[serde(default = "JwtValidationConfig::default_aud")]
    aud: Option<HashSet<String>>,
    #[serde(default = "JwtValidationConfig::default_iss")]
    iss: Option<HashSet<String>>,
}

impl JwtValidationConfig {
    fn default_required_spec_claims() -> HashSet<String> {
        HashSet::from_iter(vec!["exp".to_string()])
    }
    fn default_leeway() -> u64 {
        60
    }
    fn default_validate_exp() -> bool {
        true
    }
    fn default_validate_nbf() -> bool {
        false
    }
    fn default_aud() -> Option<HashSet<String>> {
        None
    }
    fn default_iss() -> Option<HashSet<String>> {
        None
    }
}

impl Default for JwtValidationConfig {
    fn default() -> Self {
        Self {
            required_spec_claims: HashSet::from_iter(vec!["exp".to_string()]),
            leeway: 60,
            validate_exp: true,
            validate_nbf: false,
            aud: None,
            iss: None,
        }
    }
}

#[derive(Deserialize, Clone, Debug, Getters)]
#[getset(get = "pub")]
pub struct HostConfig {
    #[serde(default = "HostConfig::default_address")]
    bind_address: String,
    #[serde(default = "HostConfig::default_port")]
    bind_port: u16,
    #[serde(default = "HostConfig::default_upload_path")]
    upload_file_path: String,
}
impl Default for HostConfig {
    fn default() -> Self {
        Self {
            bind_address: Self::default_address(),
            bind_port: Self::default_port(),
            upload_file_path: Self::default_upload_path(),
        }
    }
}
impl HostConfig {
    fn default_address() -> String {
        "0.0.0.0".to_string()
    }

    fn default_port() -> u16 {
        80
    }
    fn default_upload_path() -> String {
        "tempdir".to_string()
    }
}

#[derive(Default, Deserialize, Clone, Debug, Getters)]
#[getset(get = "pub")]
pub struct MessageQueueConfig {
    #[serde(default)]
    client_options: std::collections::HashMap<String, String>,
    #[serde(default)]
    topics: Vec<String>,
}

#[derive(Deserialize, Clone, Debug, Getters)]
#[getset(get = "pub")]
pub struct RedisConfig {
    #[serde(default = "RedisConfig::default_urls")]
    urls: Vec<String>,
    #[serde(default = "RedisConfig::default_exp_secs")]
    exp_secs: i64,
}

impl Default for RedisConfig {
    fn default() -> Self {
        Self {
            urls: Self::default_urls(),
            exp_secs: Self::default_exp_secs(),
        }
    }
}
impl RedisConfig {
    fn default_urls() -> Vec<String> {
        vec!["localhost:6379".to_string()]
    }
    fn default_exp_secs() -> i64 {
        24 * 60 * 60 * 1000
    }
}

#[derive(Deserialize, Clone, Debug, Getters)]
#[getset(get = "pub")]
pub struct DatabaseConfig {
    #[serde(default = "DatabaseConfig::default_url")]
    url: String,
}

impl DatabaseConfig {
    fn default_url() -> String {
        "postgres://postgres:postgrespassword@localhost:5432/system".to_string()
    }
}
impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            url: Self::default_url(),
        }
    }
}

pub fn build_config() -> anyhow::Result<config::Config> {
    let args: Vec<String> = std::env::args().collect();
    let mut config = config::Config::builder().add_source(
        config::File::with_name("config")
            .required(false)
            .format(config::FileFormat::Yaml),
    );
    for arg in args {
        if arg.ends_with("yaml") || arg.ends_with("yml") {
            config = config.add_source(
                config::File::from(std::path::Path::new(arg.as_str()))
                    .format(config::FileFormat::Yaml)
                    .required(false),
            );
        }
    }
    config = config.add_source(
        config::Environment::with_prefix("ALICE")
            .separator("__")
            .try_parsing(true)
            .list_separator(";")
            .with_list_parse_key("common.redis.urls"),
    );
    Ok(config.build()?)
}
