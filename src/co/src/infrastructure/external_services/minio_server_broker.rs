use kernel::prelude::*;
use rusoto_core::{credential::StaticProvider, ByteStream, HttpClient, Region};
use rusoto_s3::{GetObjectRequest, HeadObjectRequest, PutObjectRequest, S3Client, S3};
use std::ops::Range;
use tokio::io::AsyncReadExt;

#[derive(Builder)]
pub struct MinioServerBrokerService {
    meta_storage_service: Arc<dyn IMetaStorageService + Send + Sync>,
}

#[async_trait]
impl IStorageServerBrokerService for MinioServerBrokerService {
    async fn upload(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
        content: &[u8],
    ) -> AnyhowResult<ServerUrl> {
        match &storage_server.storage_type {
            StorageType::ObjectStorage { options } => {
                let client = create_s3_client(options)?;

                let bucket = options.default_bucket.to_owned();
                let server_url = ServerUrl {
                    bucket: bucket.clone(),
                    storage_server_id: storage_server.id,
                    meta_id,
                };
                let key = server_url.key();
                client
                    .put_object(PutObjectRequest {
                        body: Some(ByteStream::from(content.to_owned())),
                        bucket: bucket.to_owned(),
                        key: key.to_owned(),
                        ..Default::default()
                    })
                    .await?;

                Ok(server_url)
            }
        }
    }

    async fn rangely_get_file(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
        range: &[Range<u64>],
    ) -> AnyhowResult<Vec<Vec<u8>>> {
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
    ) -> AnyhowResult<u64> {
        match &storage_server.storage_type {
            StorageType::ObjectStorage { options } => {
                let client = create_s3_client(options)?;
                let bucket = options.default_bucket.to_owned();
                let key = format!("storage-{}/{}", storage_server.id, meta_id);

                let output = client
                    .head_object(HeadObjectRequest {
                        bucket,
                        key,
                        ..Default::default()
                    })
                    .await?;
                let content_length = match output.content_length {
                    Some(x) => x,
                    None => anyhow::bail!("No Content Length."),
                };
                return Ok(content_length as u64);
            }
        }
    }

    #[allow(warnings)]
    async fn download(&self, storage_server: &StorageServer, meta_id: Uuid) -> Anyhow {
        unimplemented!()
    }

    async fn get_download_url(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> AnyhowResult<String> {
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
    ) -> AnyhowResult<Vec<u8>> {
        self.get_content(storage_server, meta_id, None).await
    }

    async fn get_text(
        &self,
        storage_server: &StorageServer,
        meta_id: Uuid,
    ) -> AnyhowResult<String> {
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
    ) -> AnyhowResult<Vec<u8>> {
        let range = range.map(|el| format!("bytes={}-{}", el.start, el.end));

        match &storage_server.storage_type {
            StorageType::ObjectStorage { options } => {
                let client = create_s3_client(options)?;
                let bucket = options.default_bucket.to_owned();
                let key = format!("storage-{}/{}", storage_server.id, meta_id);

                let output = client
                    .get_object(GetObjectRequest {
                        bucket,
                        key: key.to_owned(),
                        range,
                        ..Default::default()
                    })
                    .await?;
                match output.body {
                    Some(el) => {
                        let mut bytes = el.into_async_read();
                        let mut buffer: Vec<u8> = Vec::with_capacity(1024);
                        bytes.read_to_end(&mut buffer).await?;
                        Ok(buffer)
                    }
                    None => {
                        bail!("Get object: {} return empty body!", key);
                    }
                }
            }
        }
    }
}

fn create_s3_client(options: &ObjectServerOption) -> anyhow::Result<S3Client> {
    let endpoint = options.endpoint.to_owned();
    let access_key_id = options.access_key_id.to_owned();
    let secret_access_key = options.secret_access_key.to_owned();
    let region = options.region.to_owned();
    Ok(S3Client::new_with(
        HttpClient::new()?,
        StaticProvider::new(access_key_id, secret_access_key, None, None),
        Region::Custom {
            name: region,
            endpoint,
        },
    ))
}
