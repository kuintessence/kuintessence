use alice_architecture::response::I18NEnum;
use uuid::Uuid;

pub type FileResult<T> = Result<T, FileException>;

#[derive(Debug, thiserror::Error, I18NEnum)]
pub enum FileException {
    #[status(100)]
    #[error("The uploading file with id: {meta_id} has the same hash: {hash} with already uploaded file: {already_id} in {destination}, so a flash upload was implemented instead.")]
    FlashUpload {
        destination: String,
        hash: String,
        meta_id: Uuid,
        #[content]
        already_id: Uuid,
    },

    #[error("A not completed multipart with meta_id:{meta_id} exists.")]
    #[status(101)]
    ConflictedId {
        #[content]
        meta_id: Uuid,
    },

    #[error("A not completed multipart, id: {meta_id} with hash:{hash} exists.")]
    #[status(102)]
    ConflictedHash {
        #[content]
        meta_id: Uuid,
        #[content]
        hash: String,
    },

    #[error("The unfinished multipart with meta_id: {meta_id} can't be found.")]
    #[status(103)]
    MultipartNotFound { meta_id: Uuid },

    #[error("The unfinished multipart with meta_id: {meta_id} doesn't have part nth: {part_nth}.")]
    #[status(104)]
    NoSuchPart { meta_id: Uuid, part_nth: usize },

    #[error(
        "File: {meta_id}'s completed hash: {completed_hash} is unmatched with provided hash: {provided_hash}."
    )]
    #[status(105)]
    UnmatchedHash {
        meta_id: Uuid,
        provided_hash: String,
        completed_hash: String,
    },
    #[error("File is empty, no need to upload.")]
    #[status(106)]
    EmptyFile,

    #[error("File internal error: {source}")]
    #[status(500)]
    InternalError {
        #[source]
        source: anyhow::Error,
    },
}

impl From<anyhow::Error> for FileException {
    fn from(e: anyhow::Error) -> Self {
        FileException::InternalError { source: e }
    }
}
