use alice_architecture::repository::IReadOnlyRepository;
use alice_architecture::utils::*;
use database_model::system::prelude::*;
use domain_workflow::model::entity::WorkflowDraft;
use sea_orm::prelude::*;

use crate::infrastructure::database::SeaOrmDbRepository;

#[async_trait::async_trait]
impl IReadOnlyRepository<WorkflowDraft> for SeaOrmDbRepository {
    async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WorkflowDraft> {
        FlowDraftEntity::find_by_id::<Uuid>(uuid.parse()?)
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
