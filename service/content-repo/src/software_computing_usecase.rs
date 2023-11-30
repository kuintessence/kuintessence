use std::sync::Arc;

use async_trait::async_trait;
use domain_content_repo::{
    model::vo::{node_ability_kind::Packages, SoftwareComputingUsecase},
    repository::PackageRepo,
    service::SoftwareComputingUsecaseInfoService,
};
use uuid::Uuid;

#[derive(typed_builder::TypedBuilder)]
pub struct SoftwareComputingUsecaseInfoServiceImpl {
    package_repo: Arc<dyn PackageRepo>,
}

#[async_trait]
impl SoftwareComputingUsecaseInfoService for SoftwareComputingUsecaseInfoServiceImpl {
    async fn get_computing_usecase(
        &self,
        software_ver_id: Uuid,
        usecase_ver_id: Uuid,
    ) -> anyhow::Result<SoftwareComputingUsecase> {
        let software = self.package_repo.get_package(software_ver_id).await?;
        let usecase = self.package_repo.get_package(usecase_ver_id).await?;
        let packages = Packages::SoftwareComputing(software, usecase);
        Ok(SoftwareComputingUsecase::extract_packages(packages))
    }
}

impl SoftwareComputingUsecaseInfoServiceImpl {
    #[inline]
    pub fn new(package_repo: Arc<dyn PackageRepo>) -> Self {
        Self { package_repo }
    }
}
