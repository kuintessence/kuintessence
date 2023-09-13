use std::str::FromStr;

use alice_infrastructure::error::{AliceCommonError, AliceError, AliceResult};
use uuid::Uuid;

pub mod agent;
pub mod dtos;
pub mod file_storage;
pub mod snapshot;
pub mod text_storage;
pub mod usecase_editor;
pub mod workflow_editor;
pub mod workflow_engine;
pub mod ws;

fn extract_uuid(s: &str) -> AliceResult<Uuid> {
    Uuid::from_str(s).map_err(|e| {
        AliceError::new(AliceCommonError::InvalidRequest {
            error_description: format!(r#"error when parse uuid from "{s}": {e}"#),
        })
    })
}
