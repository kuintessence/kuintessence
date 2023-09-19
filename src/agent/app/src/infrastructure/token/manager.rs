use reqwest::header;
use reqwest::Client;
use reqwest::RequestBuilder;
use serde::de::DeserializeOwned;
use tokio::sync::RwLock;

use crate::dto::Reply;
use crate::infrastructure::service::keycloak;

use super::Bearer;

#[derive(Debug)]
pub struct TokenManager {
    url: String,
    client_id: String,
    inner: RwLock<InnerState>,
}

#[derive(Debug)]
struct InnerState {
    access_token: Bearer,
    refresh_token: String,
}

// #[derive(Debug, thiserror::Error)]
// pub enum AuthReqError {
//     #[error("token has expired")]
//     Expiration,
//     #[error("request error: {0}")]
//     Reqwest(#[from] reqwest::Error),
// }

impl TokenManager {
    pub fn new(
        url: impl Into<String>,
        client_id: impl Into<String>,
        access_token: &str,
        refresh_token: String,
    ) -> Self {
        Self {
            url: url.into(),
            client_id: client_id.into(),
            inner: RwLock::new(InnerState {
                access_token: Bearer::new(access_token),
                refresh_token,
            }),
        }
    }

    /// Sending request with access_token.
    /// Resending one time if the token has expired.
    ///
    /// # Panic
    ///
    /// It will panic when the request body is a stream. See [reqwest::RequestBuilder::try_clone].
    ///
    /// [reqwest::RequestBuilder::try_clone]: https://docs.rs/reqwest/latest/reqwest/struct.RequestBuilder.html#method.try_clone
    pub async fn send<T: DeserializeOwned>(
        &self,
        client: &Client,
        req: RequestBuilder,
    ) -> reqwest::Result<Reply<T>> {
        let req = {
            // Release the read lock once leaving the block
            req.header(
                header::AUTHORIZATION,
                self.inner.read().await.access_token.as_str(),
            )
        };

        let reply: Reply<T> = req.try_clone().unwrap().send().await?.json().await?;

        if !reply.token_expired() {
            return Ok(reply);
        }

        self.refresh(client).await?;

        req.send().await?.json().await
    }
}

impl TokenManager {
    async fn refresh(&self, client: &Client) -> reqwest::Result<()> {
        let mut inner = self.inner.write().await;
        let grant_info =
            keycloak::refresh_token(client, &self.url, &self.client_id, &inner.refresh_token)
                .await?;
        *inner = InnerState {
            access_token: Bearer::new(&grant_info.access_token),
            refresh_token: grant_info.refresh_token,
        };
        Ok(())
    }
}
