mod background_service;
mod config;
mod dto;
mod infrastructure;
mod login;
mod server;

use std::sync::Arc;

use ::config::Config;
use alice_infrastructure::config::build_config;
use alice_infrastructure::config::CommonConfig;
use colored::Colorize;
use infrastructure::resource::ResourceStat;
use infrastructure::service::keycloak::GrantInfo;
use infrastructure::ssh_proxy::SshProxy;
use infrastructure::token::JwtPayload;

use self::config::AgentConfig;
use self::infrastructure::service_provider::ServiceProvider;
use self::infrastructure::token::TokenManager;

#[tokio::main(worker_threads = 32)]
async fn main() {
    let config = match build_config() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("{}: {e}", "Failed to build config".red());
            return;
        }
    };
    let agent_config: AgentConfig =
        config.get("agent").expect("`agent` part is absent or invalid in config");
    let ssh_proxy = Arc::new(SshProxy::new(&agent_config.ssh_proxy));

    let Some(resource_stat) =
        ResourceStat::new(&agent_config.scheduler.r#type, ssh_proxy.clone())
    else {
        eprintln!("Unsupported scheduler: {}", &agent_config.scheduler.r#type);
        return;
    };

    // Don't log before login because it will break the login interface
    let (atoken, rtoken) = match login::go(&agent_config, &resource_stat).await {
        Ok(GrantInfo {
            access_token,
            refresh_token,
        }) => (access_token, refresh_token),
        Err(e) => {
            eprintln!("{}: {e}", "Login failed".red());
            return;
        }
    };

    let token_manager = Arc::new(TokenManager::new(
        &agent_config.login.token_url,
        &agent_config.login.client_id,
        &atoken,
        rtoken,
    ));

    let common_config: CommonConfig = config.get("common").unwrap_or_default();
    if let Err(e) = alice_infrastructure::telemetry::initialize_telemetry(common_config.telemetry())
    {
        eprintln!("{}: {e}", "Failed to initialize logger".red());
        return;
    };

    let sp = match build_sp(
        config,
        ssh_proxy,
        token_manager,
        &atoken,
        Arc::new(resource_stat),
    )
    .await
    {
        Ok(sp) => sp,
        Err(e) => {
            eprintln!("{}: {e}", "Cannot build Service Provider".red());
            return;
        }
    };

    server::run(sp).await;
}

// We should replace it with try after feature *try* getting stable.
async fn build_sp(
    config: Config,
    ssh_proxy: Arc<SshProxy>,
    token_manager: Arc<TokenManager>,
    access_token: &str,
    resource_stat: Arc<ResourceStat>,
) -> anyhow::Result<Arc<ServiceProvider>> {
    let topic = JwtPayload::from_token(access_token)?.preferred_username;
    Ok(Arc::new(
        ServiceProvider::build(config, ssh_proxy, token_manager, topic, resource_stat).await?,
    ))
}
