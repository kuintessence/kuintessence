use std::time::Duration;

use reqwest::RequestBuilder;
use serde::Deserialize;
use tokio::time::sleep;

use crate::infrastructure::service::keycloak::GrantInfo;

const DELAY: Duration = Duration::from_secs(8);
/// the period of poll
const POLL_PERIOD: Duration = Duration::from_secs(10);

/// poll the token API, return error if timeout
pub async fn poll_grant(req: RequestBuilder) -> anyhow::Result<GrantInfo> {
    // waiting for a few seconds as the user may complete grant quickly
    sleep(DELAY).await;

    loop {
        match req.try_clone().unwrap().send().await?.json().await? {
            PollResult::Ok(grant_info) => {
                return Ok(grant_info);
            }

            PollResult::Err {
                error,
                error_description,
            } => {
                return Err(match error.as_str() {
                    "expired_token" => PollError::Timeout(error_description),
                    "access_denied" => PollError::AccessDenied,
                    _ => {
                        sleep(POLL_PERIOD).await;
                        continue;
                    }
                }
                .into());
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PollResult {
    Ok(GrantInfo),
    Err {
        error: String,
        error_description: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum PollError {
    #[error("{0}")]
    Timeout(String),
    #[error("you denied the device")]
    AccessDenied,
}
