use crate::prelude::*;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MoveException {
    #[error("The uploading file with id: {meta_id} has the same hash: {hash} and already uuid: {already_id} in {destination} already exists, so a flash upload instead.")]
    FlashUpload {
        destination: String,
        hash: String,
        meta_id: Uuid,
        already_id: Uuid,
    },
    #[error("Meta with id: {meta_id} has a hash conflict, registered hash is: {registered_hash}, but provided hash is: {provided_hash}")]
    HashNotMatch {
        meta_id: Uuid,
        registered_hash: String,
        provided_hash: String,
    },
}
