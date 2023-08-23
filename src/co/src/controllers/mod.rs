use alice_architecture::{base_dto::ResponseBase, exceptions::GenericError};
use std::{
    error::Error,
    marker::{Send, Sync},
};
pub mod file_storage;
pub mod snapshot;
pub mod text_storage;
pub mod usecase_editor;
pub mod workflow_editor;
pub mod workflow_engine;
pub mod ws;

pub fn handle_error<E: Error + Send + Sync + 'static, R>(e: anyhow::Error) -> HandleResult<E, R> {
    log::error!("{e}");
    let e = match e.downcast::<GenericError<E>>() {
        Ok(e) => e,
        Err(e) => {
            log::error!("Err downcast err: {e}");
            return HandleResult::Unsepecific(ResponseBase::<R>::err(500, "Interval Error."));
        }
    };
    match e {
        GenericError::Unknown => {
            HandleResult::Unsepecific(ResponseBase::<R>::err(500, "Unkonwn Error."))
        }
        GenericError::Infrastructure(..) => {
            HandleResult::Unsepecific(ResponseBase::<R>::err(500, "Interval Error."))
        }
        GenericError::Logic(cause, ..) => {
            HandleResult::Unsepecific(ResponseBase::<R>::err(400, &cause))
        }
        GenericError::Specific(e) => HandleResult::Specific(e),
    }
}

pub enum HandleResult<E: Error + Send + Sync, R> {
    Unsepecific(ResponseBase<R>),
    Specific(E),
}
