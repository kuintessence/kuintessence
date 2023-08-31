use crate::model::vo::content_extractor::{ExtractOption, ExtractResult};
use alice_architecture::utils::*;

/// Extract file content.
#[async_trait]
pub trait ContentExtractorService: Send + Sync {
    /// Extract file content.
    async fn extract(&self, content: &str, opt: ExtractOption) -> Anyhow<ExtractResult>;
}
