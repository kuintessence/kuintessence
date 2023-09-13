use async_trait::async_trait;
use uuid::Uuid;

use crate::{exception::FileResult, model::entity::MoveRegistration};

/// Move meta to its destination.
#[async_trait]
pub trait FileMoveService: Send + Sync {
    /// Register file move.
    async fn register_move(&self, info: MoveRegistration) -> FileResult<()>;
    /// Do all the registered moves of one meta.
    async fn do_registered_moves(&self, meta_id: Uuid) -> FileResult<()>;
    /// Judge whether the file satisfies flash upload, and if so, do flash upload.
    ///
    /// When flash upload, return Err.
    async fn if_possible_do_flash_upload(&self, info: &MoveRegistration) -> FileResult<()>;
    /// Set all moves with same meta_id as failed.
    async fn set_all_moves_with_same_meta_id_as_failed(
        &self,
        meta_id: Uuid,
        failed_reason: &str,
    ) -> FileResult<()>;
    /// Set a move as failed.
    async fn set_move_as_failed(&self, move_id: Uuid, failed_reason: &str) -> FileResult<()>;
    async fn get_move_info(&self, move_id: Uuid) -> FileResult<Option<MoveRegistration>>;
    async fn get_meta_id_failed_info(&self, meta_id: Uuid) -> FileResult<(bool, Option<String>)>;
    async fn remove_all_with_meta_id(&self, meta_id: Uuid) -> FileResult<()>;
}
