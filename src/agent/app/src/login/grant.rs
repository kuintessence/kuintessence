use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::time::sleep;

const DELAY: Duration = Duration::from_secs(8);
/// the period of poll
const POLL_PERIOD: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
pub struct PollParams<'a> {
    grant_type: &'static str,
    client_id: &'a str,
    device_code: &'a str,
}

/// poll the token API, return error if timeout
pub async fn poll_grant(token_url: &str, params: PollParams<'_>) -> anyhow::Result<String> {
    let req = Client::new().post(token_url).form(&params);

    // waiting for a few seconds as the user may complete grant quickly
    sleep(DELAY).await;

    loop {
        match req.try_clone().unwrap().send().await?.json().await? {
            PollResult::Ok { access_token } => {
                return Ok(access_token);
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
    Ok {
        access_token: String,
    },
    Err {
        error: String,
        error_description: String,
    },
}

impl<'a> PollParams<'a> {
    #[inline]
    pub fn new(client_id: &'a str, device_code: &'a str) -> Self {
        Self {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id,
            device_code,
        }
    }
}

pub use error::PollError;
mod error {
    #[derive(Debug)]
    pub enum PollError {
        Timeout(String),
        AccessDenied,
    }

    impl std::error::Error for PollError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            None
        }
    }

    impl std::fmt::Display for PollError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                PollError::Timeout(s) => write!(f, "{s}"),
                PollError::AccessDenied => {
                    write!(f, "you denied the device.")
                }
            }
        }
    }
}
