use crate::infrastructure::{initialize_web_host, ServiceProvider};
use alice_architecture::hosting::IBackgroundService;
use alice_di::IServiceProvider;
use alice_infrastructure::config::build_config;
use std::sync::Arc;
use tokio::task::JoinHandle;

pub struct Host;

impl Host {
    pub fn new() -> Self {
        Self
    }
    pub fn run(&self) {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(self.run_async());
    }
    pub async fn run_async(&self) {
        use colored::*;
        let config = match build_config() {
            Ok(x) => x,
            Err(e) => {
                return eprintln!("{}: {}", "Cannot build config".red(), e);
            }
        };

        let service_provider = match ServiceProvider::build(config).await {
            Ok(x) => Arc::new(x),
            Err(e) => {
                return eprintln!("{}: {}", "Cannot build Service Provider".red(), e);
            }
        };
        let common_config: alice_infrastructure::config::CommonConfig = service_provider.provide();
        if let Err(e) =
            alice_infrastructure::telemetry::initialize_telemetry(common_config.telemetry())
        {
            return eprintln!("{}: {}", "Cannot build logger".red(), e);
        };
        let tasks: Vec<Arc<dyn IBackgroundService + Send + Sync>> = service_provider.provide();
        let handles = tasks
            .into_iter()
            .map(|x| {
                tokio::spawn(async move {
                    let task = x.clone();
                    task.run().await
                })
            })
            .collect::<Vec<JoinHandle<()>>>();
        tokio::select! {
            _ = initialize_web_host(service_provider) => {

            }
            _ = tokio::signal::ctrl_c() => {
                log::info!("Stoping Services (ctrl-c handling).");
                for handle in handles {
                    handle.abort()
                }
                std::process::exit(0);
            }
        }
    }
}
