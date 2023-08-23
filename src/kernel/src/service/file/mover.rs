use crate::prelude::*;

/// Move meta to its destination.
#[async_trait]
pub trait IFileMoveService {
    /// Register file move.
    async fn register_move(&self, info: MoveRegistration) -> Anyhow;
    /// Do all the registered moves of one meta.
    async fn do_registered_moves(&self, meta_id: Uuid) -> Anyhow;
    /// Judge whether the file satisfies flash upload, and if so, do flash upload.
    ///
    /// When flash upload, return Err.
    async fn if_possible_do_flash_upload(&self, info: &MoveRegistration) -> Anyhow;
    /// Set all moves with same meta_id as failed.
    async fn set_all_moves_with_same_meta_id_as_failed(
        &self,
        meta_id: Uuid,
        failed_reason: &str,
    ) -> Anyhow;
    /// Set a move as failed.
    async fn set_move_as_failed(&self, move_id: Uuid, failed_reason: &str) -> Anyhow;
    async fn get_move_info(&self, move_id: Uuid) -> AnyhowResult<Option<MoveRegistration>>;
    async fn get_user_id(&self, move_id: Uuid) -> AnyhowResult<Option<Uuid>>;
    async fn get_meta_id_failed_info(&self, meta_id: Uuid) -> AnyhowResult<(bool, Option<String>)>;
    async fn remove_all_with_meta_id(&self, meta_id: Uuid) -> Anyhow;
}
