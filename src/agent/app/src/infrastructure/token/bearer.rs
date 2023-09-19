use std::str::FromStr;

use anyhow::Context;
use serde::Deserialize;

#[derive(Debug)]
pub struct Bearer(String);

impl Bearer {
    /// new by prepending 'bearer ' before token
    #[inline]
    pub fn new(token: &str) -> Self {
        Self(format!("bearer {token}"))
    }

    /// return the token part
    #[inline]
    pub fn token(&self) -> &str {
        self.0.split_once(' ').unwrap().1
    }

    /// return the token with prefix 'bearer '
    #[inline]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn payload(&self) -> anyhow::Result<JwtPayload> {
        JwtPayload::from_token(self.token())
    }
}

#[derive(Debug, Deserialize)]
pub struct JwtPayload {
    pub sub: String,
    pub preferred_username: String,
}

impl JwtPayload {
    #[inline]
    pub fn from_token(token: &str) -> anyhow::Result<Self> {
        token.split('.').nth(1).context("token format error")?.parse()
    }
}

impl FromStr for JwtPayload {
    type Err = anyhow::Error;

    #[inline]
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let data = base64_url::decode(s)?;
        let payload = serde_json::from_slice(&data)?;

        Ok(payload)
    }
}
