use thiserror::Error;
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum FileStorageException {
    #[error("There alreay exists a unhandled prepared multipart upload with file_metadata_id:{0}, please handle it first!")]
    ConflictedId(Uuid),
    #[error("There alreay exists a unhandled prepared multipart upload with hash: {0}, please handle it first!")]
    ConflictedHash(String),
    #[error("The file with hash: {1} is new, but the id: {0} is already exists, please use another id, or just leave it empty.")]
    NewHashButIdAlreadyExists(Uuid, String),
    #[error(
        "The hash of your file exists with file_metadata_id: {0}, so a flash upload was applied."
    )]
    FlashUpload(Uuid),
    #[error("The unfinished multipart file_metadata_id: {file_metadata_id} can't be found.")]
    MultipartNotFound { file_metadata_id: Uuid },
    #[error(
        "The completed multipart with file_metadata_id: {file_metadata_id} has a different hash."
    )]
    DifferentHashs { file_metadata_id: Uuid },
    #[error("unknown error.")]
    Unknown,
}
