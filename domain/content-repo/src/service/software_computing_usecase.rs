use async_trait::async_trait;
use uuid::Uuid;

use crate::model::vo::SoftwareComputingUsecase;

#[async_trait]
pub trait SoftwareComputingUsecaseInfoService: Send + Sync {
    /// get the data for parsing a software usecase node
    async fn get_computing_usecase(
        &self,
        software_ver_id: Uuid,
        usecase_ver_id: Uuid,
    ) -> anyhow::Result<SoftwareComputingUsecase>;
}
