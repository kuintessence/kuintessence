use alice_architecture::hosting::IBackgroundService;
use alice_di::IServiceProvider;
use colored::Colorize;
use config::Config;
use std::sync::Arc;
use tokio::task::JoinHandle;

use crate::infrastructure::service_provider::ServiceProvider;

pub async fn run(config: Config) {
    let service_provider = match ServiceProvider::build(config).await {
        Ok(x) => Arc::new(x),
        Err(e) => {
            return eprintln!("{}: {}", "Cannot build Service Provider".red(), e);
        }
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
    println!("COS Agent Started.");
    tokio::signal::ctrl_c().await.unwrap();
    log::info!("Stoping Services (ctrl-c handling).");
    for handle in handles {
        handle.abort()
    }
    std::process::exit(0);
}
