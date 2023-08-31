use std::sync::Arc;

use reqwest::header::HeaderMap;
use reqwest::Client;

use super::config::HttpClientConfig;

pub fn new(config: &HttpClientConfig) -> anyhow::Result<Arc<Client>> {
    Ok(Arc::new(
        Client::builder()
            .user_agent(config.user_agent())
            .default_headers(HeaderMap::try_from(&config.http_header().to_owned())?)
            .build()?,
    ))
}
