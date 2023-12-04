use std::sync::Arc;

use actix_easy_multipart::MultipartFormConfig;
use actix_http::StatusCode;
use actix_i18n::I18NResources;
use actix_web::middleware::ErrorHandlers;
use actix_web::web;
use alice_architecture::background_service::BackgroundService;
use alice_di::IServiceProvider;
use alice_infrastructure::config::build_config;
use alice_infrastructure::data::Database;
use alice_infrastructure::{config::CommonConfig, middleware};
use colored::Colorize;
use tokio::task::JoinHandle;
use tracing::{error, info};

use crate::api::{self, ws::ws_handler};
use crate::infrastructure::ServiceProvider;

pub fn run() {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async_run());
}

pub async fn async_run() {
    let config = match build_config() {
        Ok(x) => x,
        Err(e) => {
            return eprintln!("{}: {}", "Cannot build config".red(), e);
        }
    };

    let service_provider = match ServiceProvider::build(config).await {
        Ok(x) => Arc::new(x),
        Err(e) => {
            return eprintln!("{}: {}", "Cannot build Service Provider".red(), e);
        }
    };
    let common_config: alice_infrastructure::config::CommonConfig = service_provider.provide();
    if let Err(e) = alice_infrastructure::telemetry::initialize_telemetry(&common_config.telemetry)
    {
        return eprintln!("{}: {}", "Cannot build logger".red(), e);
    };
    let tasks: Vec<Arc<dyn BackgroundService>> = service_provider.provide();
    let handles = tasks
        .into_iter()
        .map(|x| {
            tokio::spawn(async move {
                let task = x.clone();
                task.run().await
            })
        })
        .collect::<Vec<JoinHandle<()>>>();
    tokio::select! {
        _ = initialize_web_host(service_provider) => {

        }
        _ = tokio::signal::ctrl_c() => {
            info!("Stoping Services (ctrl-c handling).");
            for handle in handles {
                handle.abort()
            }
            std::process::exit(0);
        }
    }
}

pub async fn initialize_web_host(sp: Arc<ServiceProvider>) {
    let common_config: CommonConfig = sp.provide();
    let jwt = common_config.jwt.clone();
    let rc = common_config.host.resources_config.clone();
    let database: Arc<Database> = sp.provide();
    match actix_web::HttpServer::new(move || {
        let resources = I18NResources::builder()
            .add_path("resources")
            .use_isolating(false)
            .build()
            .unwrap();
        let cors = actix_cors::Cors::default()
            .allow_any_origin()
            .allow_any_header()
            .allow_any_method()
            .max_age(86400);

        actix_web::App::new()
            .wrap(tracing_actix_web::TracingLogger::default())
            .wrap(cors)
            .app_data(resources)
            .app_data(MultipartFormConfig::default().total_limit(100 * 1024 * 1024))
            .app_data(actix_web::web::Data::from(sp.clone()))
            .service(
                web::scope("")
                    .wrap(
                        middleware::authorization::JwtValidationMiddleware::new(
                            sp.provide(),
                            jwt.clone(),
                            rc.clone(),
                            database.clone(),
                        )
                        .all_controllers(),
                    )
                    .route("/ws", web::get().to(ws_handler))
                    .service(api::workflow_editor::get_node_draft)
                    .service(api::workflow_editor::get_workflow_component_categories)
                    .service(api::workflow_editor::validate_workflow_draft)
                    .service(api::workflow_engine::start_workflow)
                    .service(api::workflow_engine::submit_workflow)
                    .service(api::workflow_engine::pause_workflow)
                    .service(api::workflow_engine::continue_workflow)
                    .service(api::workflow_engine::terminate_workflow)
                    .service(api::workflow_engine::receive_task_status)
                    .service(api::workflow_engine::get_node_cmd)
                    .service(api::text_storage::upload)
                    .service(api::text_storage::get_by_ids)
                    .route(
                        "file-storage/PreparePartialUploadFromFlowEditor",
                        web::post().to(api::file_storage::prepare_partial_upload),
                    )
                    .route(
                        "file-storage/PreparePartialUploadFromNodeInstance",
                        web::post().to(api::file_storage::prepare_partial_upload),
                    )
                    .route(
                        "file-storage/PreparePartialUploadFromSnapshot",
                        web::post().to(api::file_storage::prepare_partial_upload),
                    )
                    .route(
                        "file-storage/PreparePartialUploadFromNetDisk",
                        web::post().to(api::file_storage::prepare_partial_upload),
                    )
                    .service(api::file_storage::partial_upload)
                    .service(api::file_storage::get_partial_upload_info)
                    .service(api::file_storage::get_file_download_url)
                    .service(api::file_storage::get_file_download_urls)
                    .service(api::usecase_editor::get_template_keys)
                    .service(api::usecase_editor::package_validate)
                    .service(api::file_storage::head_rangely_download_file)
                    .service(api::file_storage::get_rangely_download_file)
                    .service(api::file_storage::cancel_partial_upload)
                    .service(api::file_storage::upload_realtime_file)
                    .service(api::file_storage::retry_partial_upload)
                    .service(api::snapshot::create_snapshot)
                    .service(api::snapshot::get_snapshots_infos)
                    .service(api::snapshot::get_snapshot)
                    .service(api::snapshot::del_snapshot)
                    .service(api::agent::register)
                    .service(api::agent::update_used_resource)
                    .service(api::agent::get_queue_cache_info),
            )
            .wrap(ErrorHandlers::new().handler(
                StatusCode::INTERNAL_SERVER_ERROR,
                middleware::error_msg_i18n::add_error_header,
            ))
            .wrap(ErrorHandlers::new().handler(
                StatusCode::BAD_REQUEST,
                middleware::error_msg_i18n::add_error_header,
            ))
    })
    .bind((
        common_config.host.bind_address.to_owned(),
        common_config.host.bind_port,
    ))
    .unwrap()
    .disable_signals()
    .run()
    .await
    {
        Ok(_) => info!("Web server stopped successfully."),
        Err(e) => error!("Web server into erorr: {}", e),
    }
}
