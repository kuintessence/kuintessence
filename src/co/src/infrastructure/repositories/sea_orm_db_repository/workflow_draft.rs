use super::SeaOrmDbRepository;
use alice_architecture::repository::IReadOnlyRepository;
use database_model::system::prelude::*;
use kernel::prelude::*;
use sea_orm::{prelude::Uuid, ColumnTrait, EntityTrait, QueryFilter};
use std::str::FromStr;

#[async_trait::async_trait]
impl IReadOnlyRepository<WorkflowDraft> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WorkflowDraft> {
        FlowDraftEntity::find_by_id(Uuid::from_str(uuid)?)
            .filter(FlowDraftColumn::UserId.eq(self.user_id(None)?))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!(
                "There is no such flow_draft with user_id: {}, id: {uuid}",
                self.user_id(None)?
            ))?
            .try_into()
    }
    async fn get_all(&self) -> anyhow::Result<Vec<WorkflowDraft>> {
        unimplemented!()
    }
}
