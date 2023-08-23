mod agent_client;
mod counter;
mod grant;

use anyhow::{anyhow, bail};
use config::Config;
use reqwest::header::AUTHORIZATION;
use reqwest::Client;

use self::agent_client::AgentClient;
use self::counter::Counter;
use self::grant::{poll_grant, PollError, PollParams};
use crate::config::AgentConfig;
use crate::infrastructure::token;
use crate::infrastructure::token::Bearer;
use crate::resource;

/// Login,
/// initialize `TOKEN` in `crate::token`,
/// print the fetched agent ID.
///
/// Return error when login fails.
pub async fn go(config: &Config) -> anyhow::Result<()> {
    let agent_config: AgentConfig = config.get("agent")?;
    let login_config = &agent_config.login;
    let proxy_config = &agent_config.ssh_proxy;
    let client = Client::new();

    let scheduler = &agent_config.scheduler.r#type;
    resource::init_stat(scheduler, proxy_config)
        .map_err(|t| anyhow!("Unsupported scheduler: {t}"))?;

    let data: AgentClient = client
        .post(&login_config.url)
        .form(&[("client_id", &login_config.client_id)])
        .send()
        .await?
        .json()
        .await?;
    println!("{data}");

    let token = {
        let counter = Counter::new(data.expires_in);
        counter.render()?; // render for the first second
        tokio::select! {
            done = counter => {
                done?;
                return Err(PollError::Timeout("verification timeout".to_owned()).into());
            }
            token = poll_grant(
                &login_config.token_url,
                PollParams::new(&login_config.client_id, &data.device_code)
            ) => {
                token?
            }
        }
    };

    let bearer = Bearer::new(&token);
    let status = client
        .post(format!("{}/agent/Register", agent_config.report_url))
        .header(AUTHORIZATION, bearer.as_str())
        .json(&resource::stat().total().await?)
        .send()
        .await?
        .status();
    if !status.is_success() {
        bail!("failed to register in computing orchestration system: response status={status}");
    }
    token::init(bearer).expect("TOKEN was set before!");

    let agent_id = token::get().payload()?.sub;
    println!("Your agent ID: {agent_id}");

    Ok(())
}
