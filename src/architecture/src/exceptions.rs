#[derive(thiserror::Error, Debug, Default)]
pub enum GenericError<E = ()> {
    #[default]
    #[error("UNKONWN.")]
    Unknown,
    #[error("INFRASTRUCTURE ERROR: {0} - err source: {1}")]
    Infrastructure(String, #[source] anyhow::Error),
    #[error("LOGIC ERROR: {0} - err source: {1}")]
    Logic(String, #[source] anyhow::Error),
    #[error("SPECIFIC ERROR: {0}")]
    Specific(E),
}
