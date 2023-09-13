use serde::{Deserialize, Serialize};

use crate::model::entity::package::{SoftwareData, UsecaseData};

/// 验证所需数据结构
#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateData {
    /// 软件包数据
    pub software_data: SoftwareData,
    /// 用例包数据
    pub usecase_data: UsecaseData,
}
