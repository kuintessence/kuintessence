use std::time::Duration;

use anyhow::bail;
use config::{Config, ConfigError};
use reqwest::{header::AUTHORIZATION, Client};
use tokio::time::sleep;
use tracing::{error, info};

use crate::config::AgentConfig;
use crate::infrastructure::token;

/// the period for reporting
const REPORT_PERIOD: Duration = Duration::from_secs(60 * 60);

pub fn start(config: &Config) -> Result<(), ConfigError> {
    let report_url = config.get::<AgentConfig>("agent")?.report_url;

    tokio::spawn(async move {
        let client = Client::new();
        loop {
            if let Err(e) = update(&client, &report_url).await {
                error!("Failed to update resources on computing orchestration system: {e}");
            }
            sleep(REPORT_PERIOD).await;
        }
    });

    Ok(())
}

async fn update(client: &Client, url: &str) -> anyhow::Result<()> {
    let resources = super::stat().used().await?;
    info!("Reporting resources: {resources}");

    let status = client
        .post(format!("{url}/agent/UpdateUsedResource"))
        .header(AUTHORIZATION, token::get().as_str())
        .json(&resources)
        .send()
        .await?
        .status();
    if !status.is_success() {
        bail!("{status}");
    }

    Ok(())
}
