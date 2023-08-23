use task_local_extensions::Extensions;

pub struct HttpRequestTimeoutMiddleware {
    timeout: u64,
}

impl HttpRequestTimeoutMiddleware {
    pub fn new(timeout: u64) -> Self {
        Self { timeout }
    }
}

#[async_trait::async_trait]
impl reqwest_middleware::Middleware for HttpRequestTimeoutMiddleware {
    async fn handle(
        &self,
        req: reqwest::Request,
        extensions: &mut Extensions,
        next: reqwest_middleware::Next<'_>,
    ) -> reqwest_middleware::Result<reqwest::Response> {
        tokio::select! {
            x = next.run(req, extensions) => {
                x
            }
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(self.timeout)) => {
                Err(reqwest_middleware::Error::Middleware(anyhow::anyhow!("Http Request Timeout. {}", self.timeout)))
            }
        }
    }
}
