use serde::Serialize;
use std::collections::HashMap;

pub struct ExtractOption {
    /// Row to start.
    pub start_row: i64,
    /// Rows per page.
    pub rows_per_page: i64,
    /// Regex to match.
    pub regex: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type", content = "body")]
/// Result of content extractor.
pub enum ExtractResult {
    PlainText(String),
    Capture(Vec<CapturedValue>),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Captured value.
pub struct CapturedValue {
    pub position_value_map: HashMap<usize, Option<String>>,
    pub name_value_map: HashMap<String, Option<String>>,
}
