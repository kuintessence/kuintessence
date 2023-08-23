use super::HttpClientConfig;
use reqwest::{header::HeaderMap, Client};
use std::{convert::TryFrom, sync::Arc};

pub fn build_http_client(config: &HttpClientConfig) -> anyhow::Result<Arc<Client>> {
    Ok(Arc::new(
        Client::builder()
            .user_agent(config.user_agent())
            .default_headers(HeaderMap::try_from(&config.http_header().to_owned())?)
            .build()?,
    ))
}
