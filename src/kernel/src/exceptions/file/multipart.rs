use thiserror::Error;
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum MultipartException {
    #[error("A not completed multipart with meta_id:{0} exists.")]
    ConflictedId(Uuid),
    #[error("A not completed multipart, id: {0} with hash:{1} exists.")]
    ConflictedHash(Uuid, String),
    #[error("The unfinished multipart with meta_id: {0} can't be found.")]
    MultipartNotFound(Uuid),
    #[error("The unfinished multipart with meta_id: {0} doesn't have part nth: {1}.")]
    NoSuchPart(Uuid, usize),
    #[error("Meta id: {0}'s Original hash: {1}. Completed hash: {2}")]
    DifferentHashs(Uuid, String, String),
}
