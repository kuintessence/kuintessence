use super::dtos::PreparePartialUpload;
use crate::api::dtos::{FileHashAlgorithm, GetPartialUploadInfoResponse, PartialUploadRequest};
use crate::api::extract_uuid;
use crate::infrastructure::ServiceProvider;
use actix_easy_multipart::MultipartForm;
use actix_http::header::{self, HeaderValue};
use actix_web::web::Path;
use actix_web::{get, head, post, web, HttpRequest, HttpResponse};
use alice_di::{actix_auto_inject, IServiceProvider};
use alice_infrastructure::error::{
    AliceCommonError, AliceError, AliceResponder, AliceResponderResult,
};
use domain_storage::model::vo::Part;
use domain_storage::service::{
    FileMoveService, MultipartService, RealtimeService, StorageServerDownloadDispatcherService,
};
use std::io::Read;
use std::ops::Range;
use std::sync::Arc;
use std::task::Poll;
use uuid::Uuid;

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("file-storage/UploadRealTimeFile")]
pub async fn upload_realtime_file(
    #[inject] service: Arc<dyn RealtimeService>,
    bytes: web::Bytes,
) -> AliceResponderResult<()> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| {
        AliceError::new(AliceCommonError::InvalidRequest {
            error_description: "realtime text contains not utf8 character.".to_string(),
        })
    })?;
    service.responde_realtime(&text).await?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
pub async fn prepare_partial_upload(
    #[inject] move_service: Arc<dyn FileMoveService>,
    #[inject] multipart_service: Arc<dyn MultipartService>,
    data: web::Json<PreparePartialUpload>,
) -> AliceResponderResult<Uuid> {
    let count = data.count;
    let registration = data.0.into_registration();
    let meta_id = registration.meta_id;
    move_service
        .if_possible_do_flash_upload(&registration)
        .await
        .map_err(AliceError::new)?;
    multipart_service
        .create(
            meta_id,
            &registration.hash.to_uppercase(),
            registration.hash_algorithm.clone(),
            count,
        )
        .await
        .map_err(AliceError::new)?;
    move_service.register_move(registration).await.map_err(AliceError::new)?;
    Ok(AliceResponder(meta_id))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("file-storage/PartialUpload")]
pub async fn partial_upload(
    #[inject] mover_service: Arc<dyn FileMoveService>,
    #[inject] multipart_service: Arc<dyn MultipartService>,
    data: MultipartForm<PartialUploadRequest>,
) -> AliceResponderResult<Vec<usize>> {
    let data = data.0;
    let contents = &data.bin;
    if contents.len() > 1 {
        return Err(AliceError::new(AliceCommonError::InvalidRequest {
            error_description: "Can't upload more than one file.".to_string(),
        }));
    }
    if contents.is_empty() {
        return Err(AliceError::new(AliceCommonError::InvalidRequest {
            error_description: "File is empty".to_string(),
        }));
    }
    let content = contents.first().unwrap();
    let bytes: Vec<u8> = content.file.as_file().bytes().map(|c| c.unwrap()).collect();

    let meta_id = data.file_metadata_id.0;
    let part = Part {
        meta_id,
        nth: data.nth.0,
        content: bytes,
    };
    let r = multipart_service.complete_part(part).await.map_err(AliceError::new)?;
    Ok(if r.is_empty() {
        mover_service.do_registered_moves(meta_id).await.map_err(AliceError::new)?;
        AliceResponder(vec![])
    } else {
        AliceResponder(r)
    })
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("/file-storage/PartialUploadInfo/{id}")]
pub async fn get_partial_upload_info(
    #[inject] multipart_service: Arc<dyn MultipartService>,
    #[inject] file_move_service: Arc<dyn FileMoveService>,
    id: Path<String>,
) -> AliceResponderResult<GetPartialUploadInfoResponse> {
    let id = extract_uuid(&id)?;
    let multipart = multipart_service.info(id).await.map_err(AliceError::new)?;
    let (is_upload_failed, failed_reason) =
        file_move_service.get_meta_id_failed_info(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(GetPartialUploadInfoResponse {
        file_metadata_id: multipart.meta_id,
        hash: multipart.hash,
        hash_algorithm: FileHashAlgorithm::from(multipart.hash_algorithm),
        shards: multipart.parts,
        is_upload_failed,
        failed_reason,
    }))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("file-storage/FileDownloadUrl/{id}")]
pub async fn get_file_download_url(
    #[inject] dispartcher_service: Arc<dyn StorageServerDownloadDispatcherService>,
    id: Path<String>,
) -> AliceResponderResult<String> {
    let id = extract_uuid(&id)?;
    let url = dispartcher_service.get_download_url(id).await?;
    Ok(AliceResponder(url))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[post("file-storage/FileDownloadUrls")]
pub async fn get_file_download_urls(
    #[inject] dispartcher_service: Arc<dyn StorageServerDownloadDispatcherService>,
    ids: web::Json<Vec<String>>,
) -> AliceResponderResult<Vec<String>> {
    let mut urls = vec![];
    let ids = ids.0;
    for id in ids {
        let id = extract_uuid(&id)?;
        let url = dispartcher_service.get_download_url(id).await?;
        urls.push(url);
    }
    Ok(AliceResponder(urls))
}

#[head("file-storage/RangelyDownloadFile/{id}")]
#[actix_auto_inject(ServiceProvider, scoped)]
pub async fn head_rangely_download_file(
    #[inject] dispatcher_service: Arc<dyn StorageServerDownloadDispatcherService>,
    id: Path<String>,
) -> actix_web::error::Result<HttpResponse> {
    let id = extract_uuid(&id)?;
    let size = dispatcher_service.get_file_size(id).await.map_err(AliceError::from)?;
    let mut response = HttpResponse::Ok().insert_header((header::ACCEPT_RANGES, "bytes")).finish();
    response.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    Ok(response)
}

#[get("file-storage/RangelyDownloadFile/{id}")]
#[actix_auto_inject(ServiceProvider, scoped)]
pub async fn get_rangely_download_file(
    #[inject] dispatcher_service: Arc<dyn StorageServerDownloadDispatcherService>,
    id: Path<String>,
    raw_req: HttpRequest,
) -> actix_web::error::Result<HttpResponse> {
    let id = extract_uuid(&id)?;
    let size = dispatcher_service.get_file_size(id).await.map_err(AliceError::from)?;
    let ranges = match raw_req.headers().get(header::RANGE) {
        Some(x) => x,
        None => {
            let bytes = dispatcher_service.get_bytes(id).await.map_err(AliceError::from)?;
            return Ok(HttpResponse::Ok().content_type("application/octet-stream").body(bytes));
        }
    };

    let ranges = ranges
        .to_str()
        .map_err(|e| {
            AliceError::new(AliceCommonError::InvalidRequest {
                error_description: format!("RANGE header is invalid: {e}"),
            })
        })?
        .strip_prefix("bytes=")
        .ok_or(AliceError::new(AliceCommonError::InvalidRequest {
            error_description: "RANGE header is invalid".to_string(),
        }))?;

    let mut new_ranges = vec![];

    for range in ranges.split(", ") {
        let mut split = range.split('-');
        let start = split
            .next()
            .ok_or(AliceError::new(AliceCommonError::InvalidRequest {
                error_description: "No start range".to_string(),
            }))?
            .parse::<u64>()
            .map_err(|e| {
                AliceError::new(AliceCommonError::InvalidRequest {
                    error_description: format!("Start range isn't a number: {e}"),
                })
            })?;

        let end = match split.next() {
            Some(x) => x.parse::<u64>().map_err(|e| {
                AliceError::new(AliceCommonError::InvalidRequest {
                    error_description: format!("End range isn't a number: {e}"),
                })
            })?,
            None => size,
        };

        if start >= end {
            return Err(AliceError::new(AliceCommonError::InvalidRequest {
                error_description: format!("Start: {start} is euqal or bigger than end: {end}"),
            })
            .into());
        }

        if end >= size {
            return Err(AliceError::new(AliceCommonError::InvalidRequest {
                error_description: format!("End: {end} is euqal or bigger than file size: {size}"),
            })
            .into());
        }

        new_ranges.push(Range { start, end });
    }

    let results = dispatcher_service
        .rangely_get_file(id, &new_ranges)
        .await
        .map_err(AliceError::from)?;

    let mut map = new_ranges.into_iter().zip(results);
    let mut count = map.len();
    Ok(if count == 1 {
        let (range, body) = map.next().unwrap();
        HttpResponse::PartialContent()
            .content_type("application/octet-stream")
            .insert_header((
                "CONTENT-RANGE",
                format!(
                    "bytes {range}/{size}",
                    range = format_args!("{}-{}", range.start, range.end),
                    size = size
                ),
            ))
            .insert_header(("CONTENT-SIZE", range.end - range.start + 1))
            .body(body)
    } else {
        let server_events = futures::stream::poll_fn(
            move |_cx| -> Poll<Option<actix_web::error::Result<web::Bytes>>> {
                let (range, mut bytes) = match map.next() {
                    Some((a, b)) => (format!("{}-{}", a.start, a.end), b),
                    None => {
                        return Poll::Ready(None);
                    }
                };
                count -= 1;
                let mut payload = format!("--{id}\nContent-Type: application/octet-stream\nContent-Range: bytes {range}/{size}\n").as_bytes().to_owned();
                payload.append(&mut bytes);
                payload.append(&mut b"\n"[..].to_owned());
                if count == 0 {
                    let mut txt2 = format!("\n--{id}\n").as_bytes().to_owned();
                    payload.append(&mut txt2);
                }
                Poll::Ready(Some(Ok(web::Bytes::from(payload))))
            },
        );
        HttpResponse::PartialContent()
            .content_type(format!("multipart/byteranges; boundary={id}"))
            .insert_header(("CONTENT-LENGTH", size))
            .streaming(server_events)
    })
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("file-storage/CancelPartialUpload/{id}")]
pub async fn cancel_partial_upload(
    #[inject] multipart_service: Arc<dyn MultipartService>,
    #[inject] move_service: Arc<dyn FileMoveService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    multipart_service.remove(id).await.map_err(AliceError::new)?;
    move_service.remove_all_with_meta_id(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}

#[actix_auto_inject(ServiceProvider, scoped)]
#[get("file-storage/RetryPartialUpload/{id}")]
pub async fn retry_partial_upload(
    #[inject] service: Arc<dyn FileMoveService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    service.do_registered_moves(id).await.map_err(AliceError::new)?;
    Ok(AliceResponder(()))
}
