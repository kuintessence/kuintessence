use actix_web::{
    get,
    http::header::ContentType,
    post,
    web::{self, Path, Query},
    HttpResponse,
};
use alice_di::{actix_auto_inject, IServiceProvider};
use alice_infrastructure::error::{AliceError, AliceResponder, AliceResponderResult};
use domain_storage::{
    command::RequestSnapshotCommand, model::entity::Snapshot, service::SnapshotService,
};
use std::sync::Arc;

use crate::{
    api::{
        dtos::{CreateSnapshotRequest, SnapshotInfoRequset},
        extract_uuid,
    },
    infrastructure::ServiceProvider,
};

/// create snapshot
#[actix_auto_inject(ServiceProvider, scoped)]
#[post("file-storage/CreateSnapshot")]
pub async fn create_snapshot(
    #[inject] snapshot_service: Arc<dyn SnapshotService>,
    data: web::Json<CreateSnapshotRequest>,
) -> AliceResponderResult<()> {
    let data = data.0;
    let node_id = data.node_id;
    let file_id = data.file_id;
    let timestamp = data.timestamp;
    snapshot_service
        .request(RequestSnapshotCommand {
            node_id,
            file_id,
            timestamp,
        })
        .await?;
    Ok(AliceResponder(()))
}

/// find snapshot
#[actix_auto_inject(ServiceProvider, scoped)]
#[get("file-storage/GetSnapshotsInfos")]
pub async fn get_snapshots_infos(
    #[inject] snapshot_service: Arc<dyn SnapshotService>,
    requset: Query<SnapshotInfoRequset>,
) -> AliceResponderResult<Vec<Snapshot>> {
    //根据 nodeid 和 fileid 查询
    let snapshots = snapshot_service
        .get_all_by_nid_and_fid(requset.node_id, requset.file_id)
        .await?;
    Ok(AliceResponder(snapshots))
}

/// delete snapshot
#[actix_auto_inject(ServiceProvider, scoped)]
#[get("file-storage/DeleteSnapshot/{id}")]
pub async fn del_snapshot(
    #[inject] snapshot_service: Arc<dyn SnapshotService>,
    id: Path<String>,
) -> AliceResponderResult<()> {
    let id = extract_uuid(&id)?;
    snapshot_service.remove(id).await?;
    Ok(AliceResponder(()))
}

/// get snapshot content
#[actix_auto_inject(ServiceProvider, scoped)]
#[get("file-storage/GetSnapshot/{id}")]
pub async fn get_snapshot(
    #[inject] snapshot_service: Arc<dyn SnapshotService>,
    id: Path<String>,
) -> actix_web::error::Result<HttpResponse> {
    let id = extract_uuid(&id)?;
    let content = snapshot_service.read(id).await.map_err(AliceError::from)?;
    Ok(HttpResponse::Ok().content_type(ContentType::octet_stream()).body(content))
}
