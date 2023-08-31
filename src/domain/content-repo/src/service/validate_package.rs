use async_trait::async_trait;

use crate::model::vo::{CommandPreview, ValidateData};

#[async_trait]
pub trait ValidatePackageService: Send + Sync {
    /// 验证打包内容的格式，返回正确或错误原因
    async fn validate_package(&self, data: ValidateData) -> anyhow::Result<CommandPreview>;
}
