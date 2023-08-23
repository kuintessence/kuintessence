use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AgentClient {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
}

impl std::fmt::Display for AgentClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "User code: {}", self.user_code)?;
        write!(
            f,
            "Please verify your identity at: {}",
            self.verification_uri
        )?;

        Ok(())
    }
}
