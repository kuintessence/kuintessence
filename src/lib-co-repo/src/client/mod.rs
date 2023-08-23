use self::graphql::*;
use crate::{
    dtos::prelude::{NodeAbilityKind, NodeDraft, Packages},
    models::{
        command_preview::CommandPreview, package::Package,
        software_computing_usecase::SoftwareComputingUsecase,
    },
    services::{
        package_validate::{IPackageValidateService, PackageValidateService, ValidateData},
        parse_node::{IParseNodeService, ParseNodeService},
    },
};
use derive_builder::Builder;
use graphql_client::{GraphQLQuery, Response};
use handlebars::{
    template::{Parameter, TemplateElement},
    Template,
};
use std::sync::Arc;
mod graphql;

#[async_trait::async_trait]
/// 包获取服务
pub trait IInfoGetter {
    /// 根据包 id 获取包
    ///
    /// # 参数
    ///
    /// * `content_entity_version_id` - 内容包版本 id
    async fn get_package(&self, content_entity_version_id: uuid::Uuid) -> anyhow::Result<Package>;

    /// 根据包 id 解析出草稿节点
    ///
    /// # 参数
    ///
    /// * `usecase_version_id` - 用例包版本 id
    /// * `software_version_id` - 软件包版本 id
    async fn get_node_draft(
        &self,
        usecase_version_id: uuid::Uuid,
        software_version_id: uuid::Uuid,
    ) -> anyhow::Result<NodeDraft>;

    /// 获得解析一个软件用例节点所需的数据
    ///
    /// * `software_version_id` - 软件包版本 id
    /// * `usecase_version_id` - 用例包版本 id
    async fn get_computing_usecase(
        &self,
        software_version_id: uuid::Uuid,
        usecase_version_id: uuid::Uuid,
    ) -> anyhow::Result<SoftwareComputingUsecase>;

    /// 获取模板键名列表
    async fn get_template_keys(&self, source: &str) -> anyhow::Result<Vec<String>>;

    /// 验证打包内容的格式，返回正确或错误原因
    async fn package_validate(&self, validate_data: ValidateData)
        -> anyhow::Result<CommandPreview>;
}

/// 软件仓库客户端
#[derive(Clone, Builder)]
pub struct CoRepoClient {
    /// http 客户端
    client: Arc<reqwest::Client>,
    co_repo_url: String,
}

#[async_trait::async_trait]
impl IInfoGetter for CoRepoClient {
    async fn get_package(&self, content_entity_version_id: uuid::Uuid) -> anyhow::Result<Package> {
        let v = get_tar_by_id::Variables {
            content_entity_version_id: content_entity_version_id.to_string(),
        };
        let request_body = GetTarById::build_query(v);
        let res = self
            .client
            .post(format!("{}/graphql", self.co_repo_url))
            .json(&request_body)
            .send()
            .await?;
        let response_body: Response<get_tar_by_id::ResponseData> = res.json().await?;
        let data = response_body.data.ok_or(anyhow::anyhow!("Data not exist."))?;
        let content_entity_version =
            data.content_entity_versions_by_id.ok_or(anyhow::anyhow!("Data not exist."))?;
        let true_url = format!(
            "{}/assets/{}?download",
            self.co_repo_url,
            content_entity_version.data.unwrap().id.unwrap()
        );
        let response = reqwest::get(true_url).await?;
        let package =
            Package::extract_package(content_entity_version_id, &response.bytes().await?)?;
        Ok(package)
    }

    async fn get_node_draft(
        &self,
        usecase_version_id: uuid::Uuid,
        software_version_id: uuid::Uuid,
    ) -> anyhow::Result<NodeDraft> {
        let software = self.get_package(software_version_id).await?;
        let usecase = self.get_package(usecase_version_id).await?;
        let node_ability =
            NodeAbilityKind::extract_packages(Packages::SoftwareComputing(usecase, software))?;
        Ok(ParseNodeService::parse_node(node_ability).await)
    }

    async fn get_computing_usecase(
        &self,
        software_version_id: uuid::Uuid,
        usecase_version_id: uuid::Uuid,
    ) -> anyhow::Result<SoftwareComputingUsecase> {
        let software = self.get_package(software_version_id).await?;
        let usecase = self.get_package(usecase_version_id).await?;
        let packages = Packages::SoftwareComputing(software, usecase);
        Ok(SoftwareComputingUsecase::extract_packages(packages))
    }

    async fn get_template_keys(&self, source: &str) -> anyhow::Result<Vec<String>> {
        let mut keys = vec![];
        let template = Template::compile(source)?;

        for element in template.elements.iter() {
            match element {
                TemplateElement::HtmlExpression(_) => {
                    anyhow::bail!("[HtmlExpression] is not implemented!")
                }
                TemplateElement::Expression(el) => match el.name {
                    Parameter::Name(_) => anyhow::bail!("[Expression::Name] is not implemented!"),
                    Parameter::Path(ref path) => match path.to_owned() {
                        handlebars::Path::Relative((_, s)) => {
                            let key = s
                                .split('.')
                                .collect::<Vec<_>>()
                                .first()
                                .ok_or(anyhow::anyhow!(
                                    "Something went wrong in [Expression::Path::Relative]!"
                                ))?
                                .to_string();
                            keys.push(key);
                        }
                        handlebars::Path::Local(_) => {
                            anyhow::bail!("[Expression::Path::Local] is not implemented!")
                        }
                    },
                    Parameter::Literal(_) => {
                        anyhow::bail!("[Expression::literal] is not implemented!")
                    }
                    Parameter::Subexpression(_) => {
                        anyhow::bail!("[Expression::Subexpression] is not implemented!")
                    }
                },
                TemplateElement::HelperBlock(el) => {
                    for param in el.params.clone() {
                        match param {
                            Parameter::Name(_) => {
                                anyhow::bail!("[HelperBlock::Parameter::Name] is not implemented!")
                            }
                            Parameter::Path(path) => match path {
                                handlebars::Path::Relative((_, s)) => {
                                    let key = s
                            .split('.')
                            .collect::<Vec<_>>()
                            .first()
                            .ok_or(anyhow::anyhow!("Something went wrong in [HelperBlock::Parameter::Path::Relative]!"))?
                            .to_string();
                                    keys.push(key);
                                }
                                handlebars::Path::Local(_) => {
                                    anyhow::bail!(
                                        "[HelperBlock::Parameter::Path::Local] is not implemented!"
                                    )
                                }
                            },
                            Parameter::Literal(_) => {
                                anyhow::bail!(
                                    "[HelperBlock::Parameter::Literal] is not implemented!"
                                )
                            }
                            Parameter::Subexpression(_) => {
                                anyhow::bail!(
                                    "[HelperBlock::Parameter::Subexpression] is not implemented!"
                                )
                            }
                        }
                    }
                }
                TemplateElement::DecoratorExpression(_) => {
                    anyhow::bail!("[DecoratorExpressionis] is not implemented!")
                }
                TemplateElement::DecoratorBlock(_) => {
                    anyhow::bail!("[DecoratorBlockis] is not implemented!")
                }
                TemplateElement::PartialExpression(_) => {
                    anyhow::bail!("[PartialExpressionis] is not implemented!")
                }
                TemplateElement::PartialBlock(_) => {
                    anyhow::bail!("PartialBlockis is not implemented!")
                }
                TemplateElement::RawString(_) | TemplateElement::Comment(_) => {}
            }
        }

        Ok(keys)
    }

    async fn package_validate(
        &self,
        validate_data: ValidateData,
    ) -> anyhow::Result<CommandPreview> {
        Ok(PackageValidateService::new().package_validate(validate_data).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[tokio::test]
    async fn test_get_node_draft() {
        let client = std::sync::Arc::new(
            reqwest::Client::builder()
                .user_agent("graphql-rust/0.10.0")
                .default_headers(
                    std::iter::once((
                        reqwest::header::AUTHORIZATION,
                        reqwest::header::HeaderValue::from_str(&format!("Bearer {}", "55555"))
                            .unwrap(),
                    ))
                    .collect(),
                )
                .build()
                .unwrap(),
        );
        let co_repo_client =
            super::CoRepoClientBuilder::default().client(client.clone()).build().unwrap();
        let node = co_repo_client
            .get_node_draft(
                uuid::Uuid::from_str("9fd567eb-9289-4db2-9064-0075b5df36dd").unwrap(),
                uuid::Uuid::from_str("3a449e44-9c45-43d8-a815-2e361ccb7431").unwrap(),
            )
            .await
            .unwrap();
        println!("{:#?}", node);
    }
}
