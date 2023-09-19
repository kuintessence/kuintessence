use tokio::process::Command;

use crate::config::SshProxyConfig;

/// An ssh proxy for command. It's transparent if not using ssh.
#[derive(Debug)]
pub struct SshProxy {
    ssh: Option<SshConfig>,
}

#[derive(Debug)]
pub struct SshConfig {
    pub port: String,
    pub username_host: String,
    pub home_dir: String,
    pub save_dir: String,
}

impl SshProxy {
    pub fn new(ssh_config: &Option<SshProxyConfig>) -> Self {
        let Some(SshProxyConfig {
            host,
            username,
            port,
            home_dir,
            save_dir,
        }) = ssh_config
        else {
            return Self { ssh: None };
        };

        Self {
            ssh: Some(SshConfig {
                port: port.to_string(),
                username_host: format!("{username}@{host}"),
                home_dir: home_dir.clone(),
                save_dir: save_dir.clone(),
            }),
        }
    }

    /// Return the command over ssh if using ssh,
    /// or return `Command::new(cmd)` directly.
    pub fn command(&self, cmd: &str) -> Command {
        let Some(ssh) = &self.ssh else {
            return Command::new(cmd);
        };

        let mut command = Command::new("ssh");
        command.args(["-p", &ssh.port, &ssh.username_host, cmd]);
        command
    }

    #[inline]
    pub fn is_proxy(&self) -> bool {
        self.ssh.is_some()
    }

    /// Return the ssh `port` and `<username>@<host>` if using ssh proxy
    #[inline]
    pub fn config(&self) -> Option<&SshConfig> {
        self.ssh.as_ref()
    }
}
