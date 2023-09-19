use alice_architecture::hosting::IBackgroundService;
use alice_di::IServiceProvider;
use std::sync::Arc;
use tokio::task::JoinHandle;

use crate::infrastructure::service_provider::ServiceProvider;

pub async fn run(sp: Arc<ServiceProvider>) {
    let tasks: Vec<Arc<dyn IBackgroundService + Send + Sync>> = sp.provide();
    let handles: Vec<JoinHandle<()>> = tasks
        .into_iter()
        .map(|task| tokio::spawn(async move { task.run().await }))
        .collect();
    log::info!("COS Agent Started.");
    tokio::signal::ctrl_c().await.unwrap();
    log::info!("Stoping Services (ctrl-c handling).");
    for handle in handles {
        handle.abort()
    }
    std::process::exit(0);
}
