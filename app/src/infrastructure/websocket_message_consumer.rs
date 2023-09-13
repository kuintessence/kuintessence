use std::sync::Arc;

use crate::infrastructure::ServiceProvider;
use alice_di::IServiceProvider;
use domain_storage::{command::ViewRealtimeCommand, service::RealtimeService};

#[alice_di::auto_inject(ServiceProvider, scoped)]
#[alice_web::message_consumer]
pub async fn ws_realtime(
    #[inject] service: Arc<dyn RealtimeService>,
    #[serialize] command: ViewRealtimeCommand,
) -> anyhow::Result<()> {
    service.request_realtime_file(command).await
}
