use async_trait::async_trait;

use crate::model::vo::content_extractor::{ExtractOption, ExtractResult};

/// Extract file content.
#[async_trait]
pub trait ContentExtractorService: Send + Sync {
    /// Extract file content.
    async fn extract(&self, content: &str, opt: ExtractOption) -> anyhow::Result<ExtractResult>;
}
