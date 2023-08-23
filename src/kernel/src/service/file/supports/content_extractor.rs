use crate::prelude::*;
use std::collections::HashMap;

/// Extract file content.
#[async_trait]
pub trait IContentExtractorService {
    /// Extract file content.
    async fn extract(&self, content: &str, opt: ExtractOption) -> AnyhowResult<ExtractResult>;
}

pub struct ExtractOption {
    /// Row to start.
    pub start_row: i64,
    /// Rows per page.
    pub rows_per_page: i64,
    /// Regex to match.
    pub regex: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase", tag = "type", content = "body")]
/// Result of content extractor.
pub enum ExtractResult {
    PlainText(String),
    Capture(Vec<CapturedValue>),
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
/// Captured value.
pub struct CapturedValue {
    pub position_value_map: HashMap<usize, Option<String>>,
    pub name_value_map: HashMap<String, Option<String>>,
}
