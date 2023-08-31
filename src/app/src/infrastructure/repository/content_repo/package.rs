use alice_architecture::IReadOnlyRepository;
use async_trait::async_trait;
use domain_content_repo::{model::entity::Package, repository::PackageRepo};
use graphql_client::{GraphQLQuery, Response};
use uuid::Uuid;

use crate::infrastructure::database::graphql::content_repo::*;

#[async_trait]
impl PackageRepo for ContentRepository {
    async fn get_package(&self, content_entity_ver_id: Uuid) -> anyhow::Result<Package> {
        let v = get_tar_by_id::Variables {
            content_entity_version_id: content_entity_ver_id.to_string(),
        };
        let request_body = GetTarById::build_query(v);
        let res = self
            .client
            .post(format!("{}/graphql", self.url))
            .json(&request_body)
            .send()
            .await?;
        let response_body: Response<get_tar_by_id::ResponseData> = res.json().await?;
        let data = response_body.data.ok_or(anyhow::anyhow!("Data not exist."))?;
        let content_entity_version =
            data.content_entity_versions_by_id.ok_or(anyhow::anyhow!("Data not exist."))?;
        let true_url = format!(
            "{}/assets/{}?download",
            self.url,
            content_entity_version.data.unwrap().id.unwrap()
        );
        let response = reqwest::get(true_url).await?;
        let package = Package::extract_package(content_entity_ver_id, &response.bytes().await?)?;

        Ok(package)
    }
}

#[async_trait]
impl IReadOnlyRepository<Package> for ContentRepository {
    async fn get_by_id(&self, _uuid: &str) -> anyhow::Result<Package> {
        unimplemented!()
    }

    async fn get_all(&self) -> anyhow::Result<Vec<Package>> {
        unimplemented!()
    }
}
