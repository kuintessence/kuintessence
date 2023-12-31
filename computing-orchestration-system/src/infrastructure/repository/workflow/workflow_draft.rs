use alice_architecture::repository::ReadOnlyRepository;

use database_model::flow_draft;
use domain_workflow::model::entity::WorkflowDraft;
use sea_orm::prelude::*;

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<WorkflowDraft> for OrmRepo {
    async fn get_by_id(&self, uuid: Uuid) -> anyhow::Result<WorkflowDraft> {
        flow_draft::Entity::find_by_id(uuid)
            .filter(flow_draft::Column::UserId.eq(self.user_id()?))
            .one(self.db.get_connection())
            .await?
            .ok_or(anyhow::anyhow!(
                "There is no such flow_draft with user_id: {}, id: {uuid}",
                self.user_id()?
            ))?
            .try_into()
    }

    async fn get_all(&self) -> anyhow::Result<Vec<WorkflowDraft>> {
        unimplemented!()
    }
}
