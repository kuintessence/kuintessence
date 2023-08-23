use crate::infrastructure::ServiceProvider;
use actix_web::{
    get,
    http::header::ContentType,
    post,
    web::{self, Json, Path, Query},
    HttpResponse,
};
use alice_architecture::base_dto::ResponseBase;
use alice_di::{actix_auto_inject, IServiceProvider};
use kernel::prelude::*;
use serde::{Deserialize, Serialize};
use std::{str::FromStr, sync::Arc};

/// create snapshot
#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[post("file-storage/CreateSnapshot")]
pub async fn create_snapshot(
    #[inject] snapshot_service: Arc<dyn ISnapshotService + Send + Sync>,
    data: web::Json<CreateSnapshotRequest>,
) -> web::Json<ResponseBase<String>> {
    let data = data.0;
    let node_id = data.node_id;
    let file_id = data.file_id;
    let timestamp = data.timestamp;
    let create_snapshot = snapshot_service
        .request(RequestSnapshotCommand {
            node_id,
            file_id,
            timestamp,
        })
        .await;
    match create_snapshot {
        Ok(_) => Json(ResponseBase::ok(None)),
        Err(e) => {
            log::error!("{e}");
            Json(ResponseBase::err(500, "create snapshot error"))
        }
    }
}

/// find snapshot
#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("file-storage/GetSnapshotsInfos")]
pub async fn get_snapshots_infos(
    #[inject] snapshot_service: Arc<dyn ISnapshotService + Send + Sync>,
    requset: Query<SnapshotInfoRequset>,
) -> actix_web::web::Json<ResponseBase<Vec<Snapshot>>> {
    //根据 nodeid 和 fileid 查询
    let snapshot =
        match snapshot_service.get_all_by_nid_and_fid(requset.node_id, requset.file_id).await {
            Ok(snapshot) => ResponseBase::ok(Some(snapshot)),
            Err(e) => {
                log::error!("{e}");
                return Json(ResponseBase::err(500, "Interval Error."));
            }
        };
    Json(snapshot)
}

/// delete snapshot
#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("file-storage/DeleteSnapshot/{id}")]
pub async fn del_snapshot(
    #[inject] snapshot_service: Arc<dyn ISnapshotService + Send + Sync>,
    id: Path<String>,
) -> actix_web::web::Json<ResponseBase<()>> {
    let id = match Uuid::from_str(&id) {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(500, "Interval Error."));
        }
    };
    let snapshot = match snapshot_service.remove(id).await {
        Ok(snapshot) => ResponseBase::ok(Some(snapshot)),
        Err(e) => {
            log::error!("{e}");
            return Json(ResponseBase::err(500, "Interval Error."));
        }
    };
    Json(snapshot)
}

/// get snapshot content
#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[get("file-storage/GetSnapshot/{id}")]
pub async fn get_snapshot(
    #[inject] snapshot_service: Arc<dyn ISnapshotService + Send + Sync>,
    id: Path<String>,
) -> HttpResponse {
    let id = match Uuid::from_str(&id) {
        Ok(el) => el,
        Err(e) => {
            log::error!("{e}");
            return HttpResponse::InternalServerError().finish();
        }
    };
    match snapshot_service.read(id).await {
        Ok(content) => HttpResponse::Ok().content_type(ContentType::octet_stream()).body(content),
        Err(e) => {
            log::error!("{e}");
            HttpResponse::InternalServerError().finish()
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfoRequset {
    node_id: Uuid,
    file_id: Uuid,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotRequest {
    pub node_id: Uuid,
    pub file_id: Uuid,
    pub timestamp: i64,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnapshotPartialRequest {
    pub node_id: Uuid,
    pub file_id: Uuid,
    pub timestamp: i64,
    pub context: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPartialUploadRequest {
    pub node_id: Uuid,
    pub file_id: Uuid,
    pub timestamp: i64,
    pub hash: String,
}
