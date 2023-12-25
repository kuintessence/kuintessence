use std::{ops::Range, sync::Arc};

use async_trait::async_trait;
use domain_storage::{
    model::{
        entity::{ObjectServerOption, StorageServer, StorageType},
        vo::ServerUrl,
    },
    service::{MetaStorageService, StorageServerBrokerService},
};
use opendal::{services::S3, Operator};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct MinioServerBrokerService {
    meta_storage_service: Arc<dyn MetaStorageService>,
}

#[async_trait]
impl StorageServerBrokerService for MinioServerBrokerService {
    async fn upload(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
        content: &[u8],
    ) -> anyhow::Result<ServerUrl> {
        match &storage_server.storage_type {
            StorageType::ObjectStorage { options } => {
                let operator = create_s3_operator(storage_server.id, options)?;

                let bucket = options.default_bucket.to_owned();
                let server_url = ServerUrl {
                    bucket,
                    storage_server_id: storage_server.id,
                    meta_id,
                };
                operator.write(&meta_id.to_string(), content.to_owned()).await?;

                Ok(server_url)
            }
        }
    }

    async fn rangely_get_file(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
        range: &[Range<u64>],
    ) -> anyhow::Result<Vec<Vec<u8>>> {
        let mut vec_rangely_file = vec![];
        for range in range.iter() {
            let content = self.get_content(storage_server, meta_id, Some(range)).await?;
            vec_rangely_file.push(content)
        }
        Ok(vec_rangely_file)
    }

    async fn get_file_size(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> anyhow::Result<u64> {
        match &storage_server.storage_type {
            StorageType::ObjectStorage { options } => {
                let operator = create_s3_operator(storage_server.id, options)?;
                let meta = operator.stat(&meta_id.to_string()).await?;

                return Ok(meta.content_length());
            }
        }
    }

    #[allow(warnings)]
    async fn download(&self, storage_server: &StorageServer, meta_id: Uuid) -> anyhow::Result<()> {
        unimplemented!()
    }

    async fn get_download_url(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> anyhow::Result<String> {
        Ok(match &storage_server.storage_type {
            StorageType::ObjectStorage { options } => {
                let server_url =
                    self.meta_storage_service.get_server_url(storage_server.id, meta_id).await?;
                let download_endpoint = &options.download_endpoint;
                format!("{download_endpoint}/{server_url}")
            }
        })
    }

    async fn get_bytes(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> anyhow::Result<Vec<u8>> {
        self.get_content(storage_server, meta_id, None).await
    }

    async fn get_text(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> anyhow::Result<String> {
        let bytes = self.get_content(storage_server, meta_id, None).await?;
        Ok(String::from_utf8(bytes)?)
    }
}

impl MinioServerBrokerService {
    async fn get_content(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
        range: Option<&Range<u64>>,
    ) -> anyhow::Result<Vec<u8>> {
        let file_key = &meta_id.to_string();
        match &storage_server.storage_type {
            StorageType::ObjectStorage { options } => {
                let operator = create_s3_operator(storage_server.id, options)?;
                Ok(match range.cloned() {
                    Some(r) => operator.read_with(file_key).range(r).await?,
                    None => operator.read(file_key).await?,
                })
            }
        }
    }
}

fn create_s3_operator(
    storage_server_id: Uuid,
    options: &ObjectServerOption,
) -> anyhow::Result<Operator> {
    let endpoint = &options.endpoint;
    let access_key_id = &options.access_key_id;
    let secret_access_key = &options.secret_access_key;
    let region = &options.region;
    let bucket = &options.default_bucket;
    let mut builder = S3::default();
    builder
        .endpoint(endpoint)
        .root(&format!("storage-{}", storage_server_id))
        .bucket(bucket)
        .region(region)
        .access_key_id(access_key_id)
        .secret_access_key(secret_access_key)
        .allow_anonymous();
    Ok(Operator::new(builder)?.finish())
}
