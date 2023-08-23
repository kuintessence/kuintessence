use actix_web::{
    dev::{forward_ready, Service, ServiceRequest, ServiceResponse, Transform},
    Error, HttpMessage,
};
use alice_architecture::authorization::{Payload, UserInfo};
use base64::{engine::general_purpose, Engine};
use futures_util::future::LocalBoxFuture;
use jsonwebtoken::{
    decode as jwt_decode,
    jwk::{AlgorithmParameters, JwkSet},
    Algorithm, DecodingKey, TokenData, Validation,
};
use reqwest::Client;
use std::{
    collections::HashMap,
    future::{ready, Ready},
    rc::Rc,
    str::FromStr,
    sync::{Arc, Mutex},
};

pub struct AddUserInfo {
    key_storage: Arc<dyn IKeyStorage + Send + Sync>,
    http_client: Arc<Client>,
    config: crate::config::JwtValidationConfig,
    not_validate: bool,
    all_controllers: bool,
}

impl AddUserInfo {
    pub fn new(
        key_storage: Arc<dyn IKeyStorage + Send + Sync>,
        http_client: Arc<Client>,
        config: crate::config::JwtValidationConfig,
    ) -> Self {
        Self {
            key_storage,
            http_client,
            config,
            not_validate: false,
            all_controllers: false,
        }
    }
    pub fn not_validate(mut self) -> Self {
        self.not_validate = true;
        self
    }
    pub fn all_controllers(mut self) -> Self {
        self.all_controllers = true;
        self
    }
}

impl<S, B> Transform<S, ServiceRequest> for AddUserInfo
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type InitError = ();
    type Transform = AddUserInfoMiddleware<S>;
    type Future = Ready<Result<Self::Transform, Self::InitError>>;

    fn new_transform(&self, service: S) -> Self::Future {
        ready(Ok(AddUserInfoMiddleware {
            service: Rc::new(service),
            key_storage: self.key_storage.clone(),
            config: self.config.clone(),
            http_client: self.http_client.clone(),
            not_validate: self.not_validate,
            all_controllers: self.all_controllers,
        }))
    }
}

pub struct AddUserInfoMiddleware<S> {
    service: Rc<S>,
    key_storage: Arc<dyn IKeyStorage + Send + Sync>,
    config: crate::config::JwtValidationConfig,
    http_client: Arc<Client>,
    not_validate: bool,
    all_controllers: bool,
}

impl<S> Clone for AddUserInfoMiddleware<S> {
    fn clone(&self) -> Self {
        Self {
            service: self.service.clone(),
            key_storage: self.key_storage.clone(),
            config: self.config.clone(),
            http_client: self.http_client.clone(),
            not_validate: self.not_validate,
            all_controllers: self.all_controllers,
        }
    }
}

impl<S, B> Service<ServiceRequest> for AddUserInfoMiddleware<S>
where
    S: Service<ServiceRequest, Response = ServiceResponse<B>, Error = Error> + 'static,
    S::Future: 'static,
    B: 'static,
{
    type Response = ServiceResponse<B>;
    type Error = Error;
    type Future = LocalBoxFuture<'static, Result<Self::Response, Self::Error>>;

    forward_ready!(service);

    fn call(&self, req: ServiceRequest) -> Self::Future {
        let service = self.service.clone();
        let key_storage = self.key_storage.clone();
        let config = self.config.clone();
        let http_client = self.http_client.clone();
        let not_validate = self.not_validate;
        let all_controllers = self.all_controllers;
        let protected_prefixs = vec!["/workflow-engine/ReceiveNodeStatus"];
        Box::pin(async move {
            let flag =
                protected_prefixs.iter().any(|el| req.path().starts_with(el)) || all_controllers;
            if !flag {
                return service.call(req).await;
            }
            let payload = match req.headers().get("Authorization") {
                Some(head) => match head.to_str() {
                    Ok(value) => {
                        match parse_jwt_token_payload(
                            value,
                            key_storage,
                            config,
                            http_client,
                            not_validate,
                        )
                        .await
                        {
                            Ok(x) => Some(UserInfo::new(x)),
                            Err(e) => {
                                log::debug!("{}", e);
                                None
                            }
                        }
                    }
                    Err(e) => {
                        log::debug!("{}", e);
                        None
                    }
                },
                None => {
                    log::debug!("No Token.");
                    None
                }
            };
            if let Some(payload) = payload {
                req.extensions_mut().insert(payload);
            }
            service.call(req).await
        })
    }
}

async fn parse_jwt_token_payload(
    authorization_str: &str,
    key_storage: Arc<dyn IKeyStorage + Send + Sync>,
    config: crate::config::JwtValidationConfig,
    http_client: Arc<Client>,
    not_validate: bool,
) -> anyhow::Result<alice_architecture::authorization::Payload> {
    let parts = authorization_str.split_whitespace().collect::<Vec<&str>>();
    if parts.len() < 2 && !parts[0].eq("Bearer") {
        anyhow::bail!("Not Bearer Token.")
    }
    let token = parts[1];
    let mut validation = Validation::default();
    validation.aud = config.aud().clone();
    validation.leeway = *config.leeway();
    validation.validate_exp = *config.validate_exp();
    validation.validate_nbf = *config.validate_nbf();
    validation.required_spec_claims = config.required_spec_claims().clone();
    validation.iss = config.iss().clone();
    let mut insecure_validation = validation.clone();
    insecure_validation.insecure_disable_signature_validation();
    let payload: TokenData<Payload> = jwt_decode(
        token,
        &DecodingKey::from_base64_secret("c2VjcmV0")?,
        &insecure_validation,
    )?;
    let header = payload.header;
    let payload = payload.claims;
    if not_validate {
        return Ok(payload);
    }
    let kid = header.kid.unwrap_or_default();
    let jwk_set = match key_storage.get(&payload.iss).await {
        Ok(x) => x,
        Err(e) => {
            log::debug!("Get key error: {e}");
            reload_keys(&payload.iss, key_storage.clone(), http_client.clone()).await?
        }
    };
    let jwk_set: JwkSet = serde_json::from_str(&jwk_set)?;
    let key = match jwk_set.keys.iter().find(|x| match &x.common.key_id {
        Some(x) => x.eq(&kid),
        None => false,
    }) {
        Some(x) => x.clone(),
        None => {
            let jwk_set =
                reload_keys(&payload.iss, key_storage.clone(), http_client.clone()).await?;
            let jwk_set: JwkSet = serde_json::from_str(&jwk_set)?;
            jwk_set
                .keys
                .iter()
                .find(|x| match &x.common.key_id {
                    Some(x) => x.eq(&kid),
                    None => false,
                })
                .ok_or(anyhow::anyhow!("Public key isn't matched."))?
                .clone()
        }
    };
    let key = match key.algorithm {
        AlgorithmParameters::RSA(ref params) => {
            DecodingKey::from_rsa_components(&params.n, &params.e)?
        }
        AlgorithmParameters::EllipticCurve(ref params) => {
            let x_cmp = general_purpose::STANDARD.decode(&params.x)?;
            let y_cmp = general_purpose::STANDARD.decode(&params.y)?;

            let mut public_key = Vec::with_capacity(1 + params.x.len() + params.y.len());
            public_key.push(0x04);
            public_key.extend_from_slice(&x_cmp);
            public_key.extend_from_slice(&y_cmp);
            DecodingKey::from_ec_der(&public_key)
        }
        AlgorithmParameters::OctetKeyPair(ref params) => {
            let x_decoded = general_purpose::STANDARD.decode(&params.x)?;
            DecodingKey::from_ed_der(&x_decoded)
        }
        AlgorithmParameters::OctetKey(ref params) => {
            DecodingKey::from_base64_secret(&params.value)?
        }
    };
    validation.algorithms = vec![Algorithm::RS256];
    let _: TokenData<Payload> = jwt_decode(token, &key, &validation)?;

    Ok(payload)
}

async fn reload_keys(
    iss: &str,
    key_storage: Arc<dyn IKeyStorage + Send + Sync>,
    http_client: Arc<Client>,
) -> anyhow::Result<String> {
    let iss_well_known_url = url::Url::from_str(iss)?.join(".well-known/openid-configuration")?;
    let well_known: WellKnownResponse =
        http_client.get(iss_well_known_url).send().await?.json().await?;
    let jwk_set = http_client.get(well_known.jwks_uri).send().await?.text().await?;
    key_storage.insert(iss, jwk_set.as_str()).await?;
    Ok(jwk_set)
}

#[derive(serde::Deserialize)]
pub struct WellKnownResponse {
    pub jwks_uri: String,
}

#[async_trait::async_trait]
pub trait IKeyStorage {
    async fn get(&self, iss: &str) -> anyhow::Result<String>;
    async fn insert(&self, iss: &str, jwk_set: &str) -> anyhow::Result<()>;
}

pub struct KeyStorage {
    storage: Arc<Mutex<HashMap<String, String>>>,
}

impl KeyStorage {
    pub fn new(storage: Arc<Mutex<HashMap<String, String>>>) -> Self {
        Self { storage }
    }
}

#[async_trait::async_trait]
impl IKeyStorage for KeyStorage {
    async fn get(&self, iss: &str) -> anyhow::Result<String> {
        let storage =
            self.storage.lock().map_err(|_| anyhow::anyhow!("Unable to lock storage."))?;
        match storage.get(iss) {
            Some(x) => Ok(x.clone()),
            None => anyhow::bail!("No such key."),
        }
    }
    async fn insert(&self, iss: &str, jwk_set: &str) -> anyhow::Result<()> {
        let mut storage =
            self.storage.lock().map_err(|_| anyhow::anyhow!("Unable to lock storage."))?;
        storage.insert(iss.to_string(), jwk_set.to_string());
        Ok(())
    }
}
