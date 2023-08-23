use super::ServiceProvider;
use crate::controllers;
use actix_easy_multipart::MultipartFormConfig;
use alice_di::IServiceProvider;
use alice_infrastructure::config::CommonConfig;
use std::sync::Arc;

pub async fn initialize_web_host(sp: Arc<ServiceProvider>) {
    let common_config: CommonConfig = sp.provide();
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
            .service(controllers::billing_system::get_flow_nodes_bill)
            .service(controllers::billing_system::webhook_subscribe)
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
