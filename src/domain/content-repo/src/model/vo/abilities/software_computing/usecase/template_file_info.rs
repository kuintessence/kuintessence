use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// 包里的模板文件
pub struct TemplateFileInfo {
    /// 模板对应的描述符
    pub descriptor: String,
    /// 模板文件的模板内容
    pub content: String,
    /// 模板文件名称
    pub file_name: String,
}
