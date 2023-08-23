mod config;
mod dtos;
mod infrastructure;
mod login;
mod resource;
mod server;

use alice_infrastructure::config::build_config;
use alice_infrastructure::config::CommonConfig;
use colored::Colorize;

#[tokio::main(worker_threads = 32)]
async fn main() {
    let config = match build_config() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("{}: {e}", "Failed to build config".red());
            return;
        }
    };

    // Don't log before login because it will break the login interface
    if let Err(e) = login::go(&config).await {
        eprintln!("{}: {e}", "Login failed".red());
        return;
    }

    let common_config: CommonConfig = config.get("common").unwrap_or_default();
    if let Err(e) = alice_infrastructure::telemetry::initialize_telemetry(common_config.telemetry())
    {
        eprintln!("{}: {e}", "Failed to initialize logger".red());
        return;
    };

    if let Err(e) = resource::report::start(&config) {
        eprintln!("{e}");
        return;
    }

    server::run(config).await;
}
