pub mod config;
pub use self::config::*;
use opentelemetry_otlp::WithExportConfig;
use tracing_appender::rolling::RollingFileAppender;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::{Layer, Registry};

/// 配置日志
pub fn initialize_telemetry(config: &TelemetryConfig) -> anyhow::Result<()> {
    if !config.enable {
        return Ok(());
    }
    let mut filter_builder = EnvFilter::builder();
    if config.level_fliter_env.ne(&String::default()) {
        filter_builder = filter_builder.with_env_var(config.level_fliter_env.as_str());
    }
    let filter = filter_builder
        .with_default_directive(config.max_level.clone().into())
        .parse_lossy(config.level_fliter.as_str());
    let console = {
        let config = &config.console;
        if config.enable {
            let enable_debug_logging = config.enable_debug_logging;
            let mut filter_builder = EnvFilter::builder();
            if config.level_fliter_env.ne(&String::default()) {
                filter_builder = filter_builder.with_env_var(config.level_fliter_env.as_str());
            }
            let filter = filter_builder
                .with_default_directive(config.max_level.clone().into())
                .parse_lossy(config.level_fliter.as_str());
            Some(
                tracing_subscriber::fmt::layer()
                    .with_file(enable_debug_logging)
                    .with_line_number(enable_debug_logging)
                    .with_thread_ids(enable_debug_logging)
                    .with_target(enable_debug_logging)
                    .with_filter(filter),
            )
        } else {
            None
        }
    };
    let file = {
        let config = &config.file;
        if config.enable {
            let enable_debug_logging = config.enable_debug_logging;
            let mut filter_builder = EnvFilter::builder();
            let file_appender = RollingFileAppender::new(
                config.rolling_time.clone().into(),
                &config.path,
                &config.prefix,
            );
            if config.level_fliter_env.ne(&String::default()) {
                filter_builder = filter_builder.with_env_var(config.level_fliter_env.as_str());
            }
            let filter = filter_builder
                .with_default_directive(config.max_level.clone().into())
                .parse_lossy(config.level_fliter.as_str());
            Some(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(file_appender)
                    .with_file(enable_debug_logging)
                    .with_line_number(enable_debug_logging)
                    .with_thread_ids(enable_debug_logging)
                    .with_target(enable_debug_logging)
                    .with_filter(filter),
            )
        } else {
            None
        }
    };
    let remote = {
        let config = config.remote.clone();
        if config.enable_trace {
            let mut exporter = opentelemetry_otlp::new_exporter().tonic();
            if config.collector_endpoint.ne(&String::default()) {
                exporter = exporter.with_endpoint(config.collector_endpoint);
            }
            let tracer = opentelemetry_otlp::new_pipeline()
                .tracing()
                .with_exporter(exporter)
                .install_batch(opentelemetry::runtime::Tokio)?;
            Some(tracing_opentelemetry::layer().with_tracer(tracer))
        } else {
            None
        }
    };
    Registry::default()
        .with(filter)
        .with(console)
        .with(file)
        .with(remote)
        .try_init()?;
    Ok(())
}
