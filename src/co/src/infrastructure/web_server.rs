use super::ServiceProvider;
use crate::controllers::{self, ws::ws_handler};
use actix_easy_multipart::MultipartFormConfig;
use actix_web::web;
use alice_di::IServiceProvider;
use alice_infrastructure::{config::CommonConfig, middleware};
use std::sync::Arc;

pub async fn initialize_web_host(sp: Arc<ServiceProvider>) {
    let common_config: CommonConfig = sp.provide();
    let jwt = common_config.jwt().clone();
    match actix_web::HttpServer::new(move || {
        let cors = actix_cors::Cors::default()
            .allow_any_origin()
            .allow_any_header()
            .allow_any_method()
            .max_age(86400);

        actix_web::App::new()
            .wrap(cors)
            .app_data(MultipartFormConfig::default().total_limit(100 * 1024 * 1024))
            .app_data(actix_web::web::Data::from(sp.clone()))
            .wrap(tracing_actix_web::TracingLogger::default())
            .wrap(
                middleware::authorization::AddUserInfo::new(
                    sp.provide(),
                    sp.provide(),
                    jwt.clone(),
                )
                .not_validate()
                .all_controllers(),
            )
            .route("/file-storage/ws", web::get().to(ws_handler))
            .service(controllers::workflow_editor::get_node_draft)
            .service(controllers::workflow_editor::get_workflow_component_categories)
            .service(controllers::workflow_editor::validate_workflow_draft)
            .service(controllers::workflow_engine::start_workflow)
            .service(controllers::workflow_engine::submit_workflow)
            .service(controllers::workflow_engine::receive_node_status)
            .service(controllers::workflow_engine::pause_workflow)
            .service(controllers::workflow_engine::continue_workflow)
            .service(controllers::workflow_engine::terminate_workflow)
            .service(controllers::workflow_engine::get_node_cmd)
            .service(controllers::text_storage::upload)
            .service(controllers::text_storage::get_by_ids)
            .service(controllers::file_storage::create_multipart_from_flow_editor)
            .service(controllers::file_storage::prepare_partial_upload_from_node_instance)
            .service(controllers::file_storage::prepare_partial_upload_from_net_disk)
            .service(controllers::file_storage::prepare_partial_upload_from_snapshot)
            .service(controllers::file_storage::partial_upload)
            .service(controllers::file_storage::get_partial_upload_info)
            .service(controllers::file_storage::get_file_download_url)
            .service(controllers::file_storage::get_file_download_urls)
            // .service(controllers::file_storage::whole_file_upload)
            .service(controllers::usecase_editor::get_template_keys)
            .service(controllers::usecase_editor::package_validate)
            .service(controllers::file_storage::head_rangely_download_file)
            .service(controllers::file_storage::get_rangely_download_file)
            .service(controllers::file_storage::cancel_partial_upload)
            .service(controllers::file_storage::upload_realtime_file)
            .service(controllers::file_storage::retry_partial_upload)
            .service(controllers::snapshot::create_snapshot)
            .service(controllers::snapshot::get_snapshots_infos)
            .service(controllers::snapshot::get_snapshot)
            .service(controllers::snapshot::del_snapshot)
    })
    .bind((
        common_config.host().bind_address().to_owned(),
        *common_config.host().bind_port(),
    ))
    .unwrap()
    .disable_signals()
    .run()
    .await
    {
        Ok(_) => log::info!("Web server stopped successfully."),
        Err(e) => log::error!("Web server into erorr: {}", e),
    }
}
