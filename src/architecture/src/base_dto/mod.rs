use serde::{Deserialize, Serialize};

/// 返回信息的包装
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseBase<T> {
    /// 状态码
    pub status: i32,
    /// 错误信息
    pub message: String,
    /// 内容
    pub content: Option<T>,
}

impl<T> ResponseBase<T> {
    pub fn new(status: i32, message: &str, content: Option<T>) -> Self {
        Self {
            status,
            message: message.to_string(),
            content,
        }
    }

    pub fn ok(content: Option<T>) -> Self {
        Self::new(200, "Ok", content)
    }

    pub fn err(status: i32, message: &str) -> Self {
        Self::new(status, message, None)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo<T> {
    pub page_size: i32,
    pub page_index: i32,
    pub total: i32,
    pub items: Vec<T>,
}

pub type PageResponse<T> = ResponseBase<PageInfo<T>>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub page_size: i32,
    pub page_index: i32,
}
