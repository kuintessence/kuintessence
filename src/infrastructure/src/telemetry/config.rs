use serde::*;
use tracing::metadata::LevelFilter;
use tracing_appender::rolling::Rotation;
use tracing_subscriber::filter::Directive;

/// 遥测系统配置
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct TelemetryConfig {
    /// 启用遥测系统
    #[serde(default = "default_enabled")]
    pub enable: bool,
    /// 全局过滤级别
    #[serde(default = "Default::default")]
    pub max_level: LoggingLevel,
    /// 全局自定义过滤规则
    #[serde(default = "Default::default")]
    pub level_fliter: String,
    /// 全局自定义过滤规则环境变量
    #[serde(default = "Default::default")]
    pub level_fliter_env: String,
    /// 控制台输出设置
    #[serde(default = "Default::default")]
    pub console: ConsoleConfig,
    /// 远程输出设置
    #[serde(default = "Default::default")]
    pub remote: RemoteConfig,
    /// 文件输出设置
    #[serde(default = "Default::default")]
    pub file: FileConfig,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        Self {
            enable: default_enabled(),
            max_level: Default::default(),
            level_fliter: Default::default(),
            level_fliter_env: Default::default(),
            console: Default::default(),
            remote: Default::default(),
            file: Default::default(),
        }
    }
}

/// 日志级别
#[derive(Default, Deserialize, Serialize, Clone, Debug)]
pub enum LoggingLevel {
    Error,
    Warn,
    Info,
    Debug,
    #[default]
    Trace,
    Off,
}

impl From<LoggingLevel> for LevelFilter {
    fn from(val: LoggingLevel) -> Self {
        match val {
            LoggingLevel::Error => LevelFilter::ERROR,
            LoggingLevel::Warn => LevelFilter::WARN,
            LoggingLevel::Info => LevelFilter::INFO,
            LoggingLevel::Debug => LevelFilter::DEBUG,
            LoggingLevel::Trace => LevelFilter::TRACE,
            LoggingLevel::Off => LevelFilter::OFF,
        }
    }
}

impl From<LoggingLevel> for Directive {
    fn from(val: LoggingLevel) -> Self {
        let level: LevelFilter = val.into();
        level.into()
    }
}

/// 调用追踪配置
#[derive(Default, Deserialize, Serialize, Clone, Debug)]
pub struct RemoteConfig {
    /// 启用调用追踪
    #[serde(default = "Default::default")]
    pub enable_trace: bool,
    /// 远程收集器地址
    #[serde(default = "Default::default")]
    pub collector_endpoint: String,
}

/// 控制台输出配置
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ConsoleConfig {
    /// 启用控制台输出
    #[serde(default = "default_enabled")]
    pub enable: bool,
    /// 启用调试输出（带有文件、行号等）
    #[serde(default = "Default::default")]
    pub enable_debug_logging: bool,
    /// 过滤级别
    #[serde(default = "Default::default")]
    pub max_level: LoggingLevel,
    /// 自定义过滤规则
    #[serde(default = "Default::default")]
    pub level_fliter: String,
    /// 自定义过滤规则环境变量
    #[serde(default = "Default::default")]
    pub level_fliter_env: String,
}

impl Default for ConsoleConfig {
    fn default() -> Self {
        Self {
            enable: default_enabled(),
            enable_debug_logging: Default::default(),
            max_level: Default::default(),
            level_fliter: Default::default(),
            level_fliter_env: Default::default(),
        }
    }
}

/// 文件输出配置
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct FileConfig {
    /// 启用文件输出
    #[serde(default = "Default::default")]
    pub enable: bool,
    /// 启用调试输出（带有文件、行号等）
    #[serde(default = "Default::default")]
    pub enable_debug_logging: bool,
    /// 过滤级别
    #[serde(default = "Default::default")]
    pub max_level: LoggingLevel,
    /// 自定义过滤规则
    #[serde(default = "Default::default")]
    pub level_fliter: String,
    /// 自定义过滤规则环境变量
    #[serde(default = "Default::default")]
    pub level_fliter_env: String,
    /// 自定义日志文件夹位置（默认 `./logs`）
    #[serde(default = "default_path")]
    pub path: String,
    /// 自定义日志文件名，或滚动写入前缀（默认 `prefix.log`）
    #[serde(default = "default_filename")]
    pub prefix: String,
    /// 滚动创建文件写入时长，默认为 `Never` 即禁止滚动创建文件写入
    #[serde(default = "Default::default")]
    pub rolling_time: RotationLevel,
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            enable: Default::default(),
            enable_debug_logging: Default::default(),
            max_level: Default::default(),
            level_fliter: Default::default(),
            level_fliter_env: Default::default(),
            path: default_path(),
            prefix: default_filename(),
            rolling_time: Default::default(),
        }
    }
}

/// 文件生成周期
#[derive(Default, Deserialize, Serialize, Clone, Debug)]
pub enum RotationLevel {
    Daily,
    Hourly,
    Minutely,
    #[default]
    Never,
}
impl From<RotationLevel> for Rotation {
    fn from(val: RotationLevel) -> Self {
        match val {
            RotationLevel::Daily => Rotation::DAILY,
            RotationLevel::Hourly => Rotation::HOURLY,
            RotationLevel::Minutely => Rotation::MINUTELY,
            RotationLevel::Never => Rotation::NEVER,
        }
    }
}
fn default_enabled() -> bool {
    true
}
fn default_path() -> String {
    "./logs".to_string()
}
fn default_filename() -> String {
    "prefix.log".to_string()
}
