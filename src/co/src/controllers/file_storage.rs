use crate::controllers::{handle_error, HandleResult};
use crate::infrastructure::ServiceProvider;
use actix_easy_multipart::tempfile::Tempfile;
use actix_easy_multipart::text::Text;
use actix_easy_multipart::MultipartForm;
use actix_http::header::{self, HeaderValue};
use actix_web::web::{Json, Path};
use actix_web::{get, head, post, web, Error, HttpResponse};
use alice_architecture::base_dto::ResponseBase;
use alice_architecture::exceptions::GenericError;
use alice_di::{actix_auto_inject, IServiceProvider};
use kernel::prelude::*;
use serde::Deserialize;
use serde::Serialize;
use std::io::Read;
use std::ops::Range;
use std::str::FromStr;
use std::sync::Arc;
use std::task::Poll;

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[post("file-storage/UploadRealTimeFile")]
pub async fn upload_realtime_file(
    #[inject] service: Arc<dyn IRealtimeService + Send + Sync>,
    data: web::Json<UploadRealtimeFileRequest>,
) -> Json<ResponseBase<String>> {
    let data = data.0;
    let request_id = data.request_id;
    log::info!("upload realtime request id:{request_id}");
    let file_content = data.content;
    let result = service.send_realtime(request_id, &file_content).await;
    Json(match result {
        Ok(_) => ResponseBase::ok(None),
        Err(e) => {
            log::error!("{e}");
            ResponseBase::err(500, "error")
        }
    })
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info.clone()")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[post("file-storage/PreparePartialUploadFromFlowEditor")]
pub async fn create_multipart_from_flow_editor(
    #[inject] move_service: Arc<dyn IFileMoveService + Send + Sync>,
    #[inject] multipart_service: Arc<dyn IMultipartService + Send + Sync>,
    data: web::Json<PreparePartialUploadFromFlowEditorRequest>,
) -> web::Json<ResponseBase<PreparePartialUploadResponse>> {
    let mut data = data.0;
    data.hash = data.hash.to_ascii_uppercase();
    let uid = user_info.unwrap().user_id;
    log::debug!(
        "FlowDraft preparing fileMetadataId is: {:?}, hash: {}, uid: {uid}",
        data.file_metadata_id,
        data.hash
    );
    let meta_id = data.file_metadata_id.unwrap_or(Uuid::new_v4());
    let hash_algorithm = match HashAlgorithm::from_str(&data.hash_algorithm) {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(400, "Hash algorithm error"));
        }
    };

    let info = MoveRegistration {
        id: Uuid::new_v4(),
        meta_id,
        file_name: data.file_name,
        hash: data.hash.to_owned(),
        hash_algorithm: hash_algorithm.to_owned(),
        size: data.size,
        destination: MoveDestination::StorageServer {
            record_net_disk: Some(RecordNetDisk {
                file_type: FileType::Unkonwn,
                kind: RecordNetDiskKind::FlowDraft {
                    flow_draft_id: data.flow_draft_uuid,
                },
            }),
        },
        is_upload_failed: false,
        failed_reason: None,
        user_id: None,
    };

    if let Err(e) = move_service.if_possible_do_flash_upload(&info).await {
        let x = handle_error(e);
        match x {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MoveException::FlashUpload { already_id, .. } => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        result: PreparePartialUploadResponseResult::FlashUpload,
                        id: already_id,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }

    if let Err(e) = multipart_service.create(meta_id, &data.hash, hash_algorithm, data.count).await
    {
        match handle_error(e) {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MultipartException::ConflictedId(id) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::ConflictedId,
                    })))
                }
                MultipartException::ConflictedHash(id, _hash) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::Unfinished,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }

    if let Err(e) = move_service.register_move(info).await {
        log::error!("{e}");
        return Json(ResponseBase::err(500, "interval error"));
    };

    Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
        result: PreparePartialUploadResponseResult::Normal,
        id: meta_id,
    })))
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[post("file-storage/PreparePartialUploadFromNodeInstance")]
pub async fn prepare_partial_upload_from_node_instance(
    #[inject] move_service: Arc<dyn IFileMoveService + Send + Sync>,
    #[inject] multipart_service: Arc<dyn IMultipartService + Send + Sync>,
    #[inject] workflow_service: Arc<dyn IWorkflowService + Send + Sync>,
    data: web::Json<PreparePartialUploadFromNodeInstanceRequest>,
) -> web::Json<ResponseBase<PreparePartialUploadResponse>> {
    let mut data = data.0;
    data.hash = data.hash.to_ascii_uppercase();
    log::debug!(
        "NodeInstance preparing fileMetadataId is: {:?}, hash: {}",
        data.file_metadata_id,
        data.hash
    );
    let meta_id = data.file_metadata_id;
    let hash_algorithm = match HashAlgorithm::from_str(&data.hash_algorithm) {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(400, "Hash algorithm error"));
        }
    };
    let user_id = match workflow_service.get_node_user_id(data.node_instance_uuid).await {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(500, "Interval error."));
        }
    };
    let info = MoveRegistration {
        id: Uuid::new_v4(),
        meta_id,
        file_name: data.file_name,
        hash: data.hash.to_owned(),
        hash_algorithm: hash_algorithm.to_owned(),
        size: data.size,
        destination: MoveDestination::StorageServer {
            record_net_disk: Some(RecordNetDisk {
                file_type: FileType::Unkonwn,
                kind: RecordNetDiskKind::NodeInstance {
                    node_id: data.node_instance_uuid,
                },
            }),
        },
        is_upload_failed: false,
        failed_reason: None,
        user_id: Some(user_id),
    };

    if let Err(e) = move_service.if_possible_do_flash_upload(&info).await {
        match handle_error(e) {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MoveException::FlashUpload { already_id, .. } => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        result: PreparePartialUploadResponseResult::FlashUpload,
                        id: already_id,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }

    if let Err(e) = multipart_service.create(meta_id, &data.hash, hash_algorithm, data.count).await
    {
        match handle_error(e) {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MultipartException::ConflictedId(id) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::ConflictedId,
                    })))
                }
                MultipartException::ConflictedHash(id, _hash) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::Unfinished,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }
    if let Err(e) = move_service.register_move(info).await {
        log::error!("{e}");
        return Json(ResponseBase::err(500, "interval error"));
    };
    Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
        result: PreparePartialUploadResponseResult::Normal,
        id: meta_id,
    })))
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info.clone()")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[post("file-storage/PreparePartialUploadFromNetDisk")]
pub async fn prepare_partial_upload_from_net_disk(
    #[inject] move_service: Arc<dyn IFileMoveService + Send + Sync>,
    #[inject] multipart_service: Arc<dyn IMultipartService + Send + Sync>,
    data: web::Json<PreparePartialUploadFromNetDiskRequest>,
) -> web::Json<ResponseBase<PreparePartialUploadResponse>> {
    let mut data = data.0;
    data.hash = data.hash.to_ascii_uppercase();
    let uid = user_info.unwrap().user_id;
    log::debug!(
        "NetDisk preparing fileMetadataId is: {:?}, hash: {}, uid: {uid}",
        data.file_metadata_id,
        data.hash
    );
    let meta_id = data.file_metadata_id.unwrap_or(Uuid::new_v4());
    let hash_algorithm = match HashAlgorithm::from_str(&data.hash_algorithm) {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(400, "Hash algorithm error"));
        }
    };

    let info = MoveRegistration {
        id: Uuid::new_v4(),
        meta_id,
        file_name: data.file_name,
        hash: data.hash.to_owned(),
        hash_algorithm: hash_algorithm.to_owned(),
        size: data.size,
        destination: MoveDestination::StorageServer {
            record_net_disk: Some(RecordNetDisk {
                file_type: FileType::Unkonwn,
                kind: RecordNetDiskKind::Normal {
                    parent_id: data.parent_id,
                },
            }),
        },
        is_upload_failed: false,
        failed_reason: None,
        user_id: None,
    };

    if let Err(e) = move_service.if_possible_do_flash_upload(&info).await {
        match handle_error(e) {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MoveException::FlashUpload { already_id, .. } => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        result: PreparePartialUploadResponseResult::FlashUpload,
                        id: already_id,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }

    if let Err(e) = multipart_service.create(meta_id, &data.hash, hash_algorithm, data.count).await
    {
        match handle_error(e) {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MultipartException::ConflictedId(id) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::ConflictedId,
                    })))
                }
                MultipartException::ConflictedHash(id, _hash) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::Unfinished,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }

    if let Err(e) = move_service.register_move(info).await {
        log::error!("{e}");
        return Json(ResponseBase::err(500, "interval error"));
    };

    Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
        result: PreparePartialUploadResponseResult::Normal,
        id: meta_id,
    })))
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[post("file-storage/PreparePartialUploadFromSnapshot")]
pub async fn prepare_partial_upload_from_snapshot(
    #[inject] move_service: Arc<dyn IFileMoveService + Send + Sync>,
    #[inject] multipart_service: Arc<dyn IMultipartService + Send + Sync>,
    #[inject] workflow_service: Arc<dyn IWorkflowService + Send + Sync>,
    data: web::Json<PreparePartialUploadFromSnapshotRequest>,
) -> web::Json<ResponseBase<PreparePartialUploadResponse>> {
    let mut data = data.0;
    data.hash = data.hash.to_ascii_uppercase();
    log::debug!(
        "Snapshot preparing fileId is: {:?}, hash: {}",
        data.file_id,
        data.hash
    );
    let meta_id = Uuid::new_v4();
    let hash_algorithm = match HashAlgorithm::from_str(&data.hash_algorithm) {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(400, "Hash algorithm error"));
        }
    };
    let user_id = match workflow_service.get_node_user_id(data.node_id).await {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(500, "Interval error."));
        }
    };
    let info = MoveRegistration {
        id: Uuid::new_v4(),
        meta_id,
        file_name: data.file_name,
        hash: data.hash.to_owned(),
        hash_algorithm: hash_algorithm.to_owned(),
        size: data.size,
        destination: MoveDestination::Snapshot {
            node_id: data.node_id,
            timestamp: data.timestamp,
            file_id: data.file_id,
        },
        is_upload_failed: false,
        failed_reason: None,
        user_id: Some(user_id),
    };

    if let Err(e) = move_service.if_possible_do_flash_upload(&info).await {
        match handle_error(e) {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MoveException::FlashUpload { already_id, .. } => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        result: PreparePartialUploadResponseResult::FlashUpload,
                        id: already_id,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }

    if let Err(e) = multipart_service.create(meta_id, &data.hash, hash_algorithm, data.count).await
    {
        match handle_error(e) {
            HandleResult::Unsepecific(response) => return Json(response),
            HandleResult::Specific(e) => match e {
                MultipartException::ConflictedId(id) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::ConflictedId,
                    })))
                }
                MultipartException::ConflictedHash(id, _hash) => {
                    return Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
                        id,
                        result: PreparePartialUploadResponseResult::Unfinished,
                    })))
                }
                _ => return Json(ResponseBase::err(500, "interval error")),
            },
        }
    }

    if let Err(e) = move_service.register_move(info).await {
        log::error!("{e}");
        return Json(ResponseBase::err(500, "interval error"));
    };

    Json(ResponseBase::ok(Some(PreparePartialUploadResponse {
        result: PreparePartialUploadResponseResult::Normal,
        id: meta_id,
    })))
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize(allow_none_user_id)]
#[post("file-storage/PartialUpload")]
pub async fn partial_upload(
    #[inject] mover_service: Arc<dyn IFileMoveService + Send + Sync>,
    #[inject] multipart_service: Arc<dyn IMultipartService + Send + Sync>,
    data: MultipartForm<PartialUploadRequest>,
) -> actix_web::web::Json<ResponseBase<Vec<usize>>> {
    let data = data.0;
    log::debug!(
        "PartialUploading piece {} to fileMetadataId: {}",
        data.nth.0,
        data.file_metadata_id.0
    );
    let contents = &data.bin;
    if contents.len() > 1 {
        return Json(ResponseBase::err(400, "Can't upload more than one file."));
    }
    if contents.is_empty() {
        return Json(ResponseBase::err(400, "No file to upload ."));
    }
    let content = contents.first().unwrap();
    let bytes: Vec<u8> = content.file.as_file().bytes().map(|c| c.unwrap()).collect();

    let meta_id = data.file_metadata_id.0;
    let part = Part {
        meta_id,
        nth: data.nth.0,
        content: bytes,
    };

    let response = match multipart_service.complete_part(part).await {
        Ok(result) => {
            if result.is_empty() {
                if let Err(e) = mover_service.do_registered_moves(meta_id).await {
                    log::error!("{e}");
                    return Json(ResponseBase::err(500, "Interval error."));
                }
                ResponseBase::new(200, "分片已全部上传至后台，等待后台合并上传", None)
            } else {
                ResponseBase::new(200, "分片上传成功", Some(result))
            }
        }
        Err(e) => match handle_error(e) {
            HandleResult::Unsepecific(r) => r,
            HandleResult::Specific(e) => match &e {
                MultipartException::MultipartNotFound { .. } => {
                    ResponseBase::err(400, e.to_string().as_str())
                }
                MultipartException::DifferentHashs(_id, origin_hash, completed_hash) => {
                    let _ = mover_service
                        .set_all_moves_with_same_meta_id_as_failed(meta_id, &e.to_string())
                        .await;
                    ResponseBase::err(
                        400,
                        &format!("合并后的哈希值：{completed_hash}，与创建分片上传时提供的哈希值：{origin_hash} 不符"),
                    )
                }
                _ => ResponseBase::err(500, "No Such Error."),
            },
        },
    };

    Json(response)
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[get("file-storage/PartialUploadInfo/{id}")]
pub async fn get_partial_upload_info(
    #[inject] multipart_service: Arc<dyn IMultipartService + Send + Sync>,
    #[inject] file_move_service: Arc<dyn IFileMoveService + Send + Sync>,
    id: Path<String>,
) -> actix_web::web::Json<ResponseBase<GetPartialUploadInfoResponse>> {
    log::debug!("Getting PartialUploadInfo id: {id}");
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("get_partial_upload_info uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Uuid format error."));
        }
    };

    let response = match multipart_service.info(id).await {
        Ok(el) => {
            let (is_upload_failed, failed_reason) =
                match file_move_service.get_meta_id_failed_info(id).await {
                    Ok(el) => el,
                    Err(e) => {
                        log::error!("{e}");
                        return Json(ResponseBase::err(500, "Interval Error."));
                    }
                };
            ResponseBase::ok(Some(GetPartialUploadInfoResponse {
                file_metadata_id: el.meta_id,
                hash: el.hash,
                hash_algorithm: el.hash_algorithm.to_string(),
                shards: el.parts,
                is_upload_failed,
                failed_reason,
            }))
        }
        Err(e) => {
            log::error!("{e}");
            match e.downcast::<GenericError<MultipartException>>() {
                Ok(e) => match e {
                    GenericError::Unknown => ResponseBase::err(500, "未知错误"),
                    GenericError::Infrastructure(..) => ResponseBase::err(500, "Interval Error."),
                    GenericError::Logic(..) => ResponseBase::err(400, "Logic Error."),
                    GenericError::Specific(e2) => ResponseBase::err(400, &format!("{e2}")),
                },
                Err(_) => ResponseBase::err(400, "Interval Error."),
            }
        }
    };
    Json(response)
}

// #[actix_auto_inject(ServiceProvider, scoped = "user_info")]
// #[alice_web_macro::http_request]
// #[alice_web_macro::authorize]
// #[post("file-storage/WholeFileUpload")]
// pub async fn whole_file_upload(
//     #[inject] service: std::sync::Arc<dyn IFileStorageService + Send + Sync>,
//     data: MultipartForm<WholeFileUploadRequest>,
// ) -> actix_web::web::Json<ResponseBase<String>> {
//     let data = data.0;
//     log::debug!("Whole file upload id: {:?}", data.file_metadata_id);
//     let files = &data.files;
//     if files.len() > 1 {
//         return Json(ResponseBase::err(400, "Can't upload more than one file."));
//     }
//     if files.len() < 1 {
//         return Json(ResponseBase::err(400, "Didn't upload file."));
//     }
//     let file = files.get(0).unwrap();
//     let bytes: Vec<u8> = file
//         .file
//         .as_file()
//         .bytes()
//         .into_iter()
//         .map(|f| f.unwrap())
//         .collect();
//     let response = match service
//         .whole_file_upload(
//             data.file_metadata_id.map(|el| el.0),
//             &data.name,
//             &data.hash,
//             &data.hash_algorithm,
//             *data.size,
//             &bytes,
//         )
//         .await
//     {
//         Ok(_) => ResponseBase::new(200, "文件上传成功", None),
//         Err(e) => {
//             log::error!("{e}");
//             match e.downcast::<GenericError<FileStorageException>>() {
//                 Ok(e) => match e {
//                     GenericError::Unknown => ResponseBase::err(500, "未知错误"),
//                     GenericError::Infrastructure(..) => ResponseBase::err(500, "Interval Error."),
//                     GenericError::Logic(..) => ResponseBase::err(400, "Logic Error."),
//                     GenericError::Specific(s) => ResponseBase::err(400, &format!("{s}")),
//                 },
//                 Err(_) => ResponseBase::err(400, "Interval Error."),
//             }
//         }
//     };
//     Json(response)
// }

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[get("file-storage/FileDownloadUrl/{id}")]
pub async fn get_file_download_url(
    #[inject] dispartcher_service: std::sync::Arc<
        dyn IStorageServerDownloadDispatcherService + Send + Sync,
    >,
    id: Path<String>,
) -> actix_web::web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("get_file_download_url uuid parse error: {e}");
            return Json(ResponseBase::err(400, "Interval Error."));
        }
    };

    let response = match dispartcher_service.get_download_url(id).await {
        Ok(url) => ResponseBase::ok(Some(url)),
        Err(e) => {
            log::error!("{e}");
            match e.downcast::<GenericError<FileStorageException>>() {
                Ok(e) => match e {
                    GenericError::Unknown => ResponseBase::err(500, "未知错误"),
                    GenericError::Infrastructure(..) => ResponseBase::err(500, "Interval Error."),
                    GenericError::Logic(..) => ResponseBase::err(400, "Logic Error."),
                    GenericError::Specific(s) => ResponseBase::err(400, &format!("{s}")),
                },
                Err(_) => ResponseBase::err(400, "Interval Error."),
            }
        }
    };
    Json(response)
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[post("file-storage/FileDownloadUrls")]
pub async fn get_file_download_urls(
    #[inject] dispartcher_service: std::sync::Arc<
        dyn IStorageServerDownloadDispatcherService + Send + Sync,
    >,
    ids: web::Json<Vec<String>>,
) -> actix_web::web::Json<ResponseBase<Vec<String>>> {
    let mut urls = vec![];
    let ids = ids.0;
    for id in ids {
        let id = match Uuid::from_str(&id) {
            Ok(id) => id,
            Err(e) => {
                log::error!("get_file_download_urls uuid parse error: {e}");
                return Json(ResponseBase::err(500, "Interval Error."));
            }
        };

        match dispartcher_service.get_download_url(id).await {
            Ok(el) => urls.push(el),
            Err(e) => {
                log::error!("{e}");
                return Json(match e.downcast::<GenericError<FileStorageException>>() {
                    Ok(e) => match e {
                        GenericError::Unknown => ResponseBase::err(500, "未知错误"),
                        GenericError::Infrastructure(..) => {
                            ResponseBase::err(500, "Interval Error.")
                        }
                        GenericError::Logic(..) => ResponseBase::err(400, "Logic Error."),
                        GenericError::Specific(s) => ResponseBase::err(400, &format!("{s}")),
                    },
                    Err(_) => ResponseBase::err(400, "Interval Error."),
                });
            }
        }
    }
    Json(ResponseBase::ok(Some(urls)))
}

#[head("file-storage/RangelyDownloadFile/{id}")]
#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
pub async fn head_rangely_download_file(
    #[inject] dispatcher_service: Arc<dyn IStorageServerDownloadDispatcherService + Send + Sync>,
    id: Path<String>,
) -> HttpResponse {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("head_rangely_download_file uuid parse error: {e}");
            return HttpResponse::InternalServerError().finish();
        }
    };

    let size = match dispatcher_service.get_file_size(id).await {
        Ok(size) => size,
        Err(e) => {
            log::error!("head_rangely_download_file get_file_size error: {e}");
            return HttpResponse::InternalServerError().finish();
        }
    };

    let mut response = HttpResponse::Ok()
        .insert_header((header::ACCEPT_RANGES, "bytes"))
        // .insert_header(("CONTENT-SIZE", size))
        .finish();
    response.headers_mut().insert(header::CONTENT_LENGTH, HeaderValue::from(size));
    response
}

#[get("file-storage/RangelyDownloadFile/{id}")]
#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
pub async fn get_rangely_download_file(
    #[inject] dispatcher_service: Arc<dyn IStorageServerDownloadDispatcherService + Send + Sync>,
    id: Path<String>,
) -> HttpResponse {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("get_rangely_download_file uuid parse error: {e}");
            return HttpResponse::InternalServerError().finish();
        }
    };

    let ranges = match raw_req.headers().get(header::RANGE) {
        Some(x) => x,
        None => match dispatcher_service.get_bytes(id).await {
            Ok(x) => return HttpResponse::Ok().body(x),
            Err(e) => {
                log::error!("get_rangely_download_file get bytes error: {e}");
                return HttpResponse::InternalServerError().finish();
            }
        },
    };

    let ranges = match ranges.to_str() {
        Ok(x) => match x.strip_prefix("bytes=") {
            Some(x) => x,
            None => {
                return HttpResponse::BadRequest().body("RANGE header is invalid".to_string());
            }
        },
        Err(e) => {
            log::error!("{e}");
            return HttpResponse::BadRequest().body("RANGE header is invalid".to_string());
        }
    };
    let mut new_ranges = vec![];
    for range in ranges.split(", ") {
        let mut split = range.split('-');
        let start = match split.next() {
            Some(x) => match u64::from_str(x) {
                Ok(x) => x,
                Err(e) => {
                    log::error!("{e}");
                    return HttpResponse::BadRequest().body("RANGE header is invalid".to_string());
                }
            },
            None => {
                return HttpResponse::BadRequest().body("RANGE header is invalid".to_string());
            }
        };
        let end = match split.next() {
            Some(x) => match u64::from_str(x) {
                Ok(x) => x,
                Err(e) => {
                    log::error!("{e}");
                    return HttpResponse::BadRequest().body("RANGE header is invalid".to_string());
                }
            },
            None => {
                return HttpResponse::BadRequest().body("RANGE header is invalid".to_string());
            }
        };
        new_ranges.push(Range { start, end });
    }

    let results = match dispatcher_service.rangely_get_file(id, &new_ranges).await {
        Ok(x) => x,
        Err(e) => {
            log::error!("{e}");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let mut map = new_ranges.into_iter().zip(results);
    let size = match dispatcher_service.get_file_size(id).await {
        Ok(size) => size,
        Err(e) => {
            log::error!("head_rangely_download_file get_file_size error: {e}");
            return HttpResponse::InternalServerError().finish();
        }
    };
    let mut count = map.len();
    if count == 1 {
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
            move |_cx| -> Poll<Option<Result<web::Bytes, Error>>> {
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
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
// #[alice_web_macro::authorize]
#[get("file-storage/CancelPartialUpload/{id}")]
pub async fn cancel_partial_upload(
    #[inject] multipart_service: Arc<dyn IMultipartService + Send + Sync>,
    #[inject] move_service: Arc<dyn IFileMoveService + Send + Sync>,
    id: Path<String>,
) -> actix_web::web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("cancel_partial_upload uuid parse error: {e}");
            return Json(ResponseBase::err(500, "Interval Error."));
        }
    };

    let response = match multipart_service.remove(id).await {
        Ok(_) => match move_service.remove_all_with_meta_id(id).await {
            Ok(_) => ResponseBase::ok(None),
            Err(e) => match handle_error::<MoveException, _>(e) {
                HandleResult::Unsepecific(r) => r,
                HandleResult::Specific(_) => {
                    unreachable!()
                }
            },
        },

        Err(e) => {
            return Json(match handle_error::<MultipartException, _>(e) {
                HandleResult::Unsepecific(r) => r,
                HandleResult::Specific(_) => {
                    unreachable!()
                }
            })
        }
    };
    Json(response)
}

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[get("file-storage/RetryPartialUpload/{id}")]
pub async fn retry_partial_upload(
    #[inject] service: std::sync::Arc<dyn IFileMoveService + Send + Sync>,
    id: Path<String>,
) -> actix_web::web::Json<ResponseBase<String>> {
    let id = match Uuid::from_str(&id) {
        Ok(id) => id,
        Err(e) => {
            log::error!("retry_partial_upload uuid parse error: {e}");
            return Json(ResponseBase::err(500, "Interval Error."));
        }
    };

    let response = match service.do_registered_moves(id).await {
        Ok(_) => ResponseBase::ok(None),
        Err(e) => {
            log::error!("{e}");
            ResponseBase::err(400, "Interval Error.")
        }
    };
    Json(response)
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadNameAndUrlResponse {
    pub url: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUploadFromFlowEditorRequest {
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: String,
    pub size: usize,
    pub count: usize,
    pub flow_draft_uuid: Uuid,
    pub file_metadata_id: Option<Uuid>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUploadFromNodeInstanceRequest {
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: String,
    pub size: usize,
    pub count: usize,
    pub node_instance_uuid: Uuid,
    pub file_metadata_id: Uuid,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUploadFromNetDiskRequest {
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: String,
    pub size: usize,
    pub count: usize,
    pub parent_id: Option<Uuid>,
    pub file_metadata_id: Option<Uuid>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUploadFromSnapshotRequest {
    pub file_name: String,
    pub hash: String,
    pub hash_algorithm: String,
    pub size: usize,
    pub count: usize,
    pub node_id: Uuid,
    pub file_id: Uuid,
    pub timestamp: i64,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreparePartialUploadResponse {
    pub result: PreparePartialUploadResponseResult,
    pub id: Uuid,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PreparePartialUploadResponseResult {
    Normal,
    Unfinished,
    FlashUpload,
    ConflictedId,
}

#[derive(MultipartForm)]
pub struct PartialUploadRequest {
    pub file_metadata_id: Text<Uuid>,
    pub nth: Text<usize>,
    pub bin: Vec<Tempfile>,
}

#[derive(MultipartForm)]
pub struct WholeFileUploadRequest {
    pub file_metadata_id: Option<Text<Uuid>>,
    pub name: Text<String>,
    pub files: Vec<Tempfile>,
    pub hash: Text<String>,
    pub hash_algorithm: Text<String>,
    pub size: Text<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadRealtimeFileRequest {
    pub request_id: Uuid,
    pub content: String,
}

#[derive(Serialize)]
pub struct GetPartialUploadInfoResponse {
    pub file_metadata_id: Uuid,
    pub hash: String,
    pub hash_algorithm: String,
    pub shards: Vec<bool>,
    pub is_upload_failed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_reason: Option<String>,
}
