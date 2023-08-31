use std::string::FromUtf8Error;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Exception {
    #[error("no such path: {0}.\n{1}")]
    NoSuchPath(String, #[source] std::io::Error),
    #[error("path codec error: {0}.")]
    PathCodecError(String),
    #[error("io error.\n{0}")]
    IOError(#[source] std::io::Error),
    #[error("can't open manifest file: {0}.yml or {0}.yaml.")]
    NoManifest(String),
    #[error("content of file: {0} is not utf-8.\n{1}")]
    NotUtf8(String, #[source] FromUtf8Error),
    #[error("file: {0} failed to pass JsonSchema validate\n{1}")]
    FailJsonSchema(String, #[source] anyhow::Error),
    #[error("unknown error.")]
    Unknown,
}
