use billing_system_kernel::prelude::*;
use sea_orm::{entity::prelude::*, Set};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Eq)]
#[sea_orm(table_name = "user_webhook")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub user_id: Uuid,
    pub url: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

impl TryInto<UserWebhook> for Model {
    type Error = anyhow::Error;

    fn try_into(self) -> Result<UserWebhook, Self::Error> {
        Ok(UserWebhook {
            id: self.id,
            user_id: self.user_id,
            url: self.url,
        })
    }
}

impl TryFrom<UserWebhook> for Model {
    type Error = anyhow::Error;

    fn try_from(l: UserWebhook) -> Result<Self, Self::Error> {
        Ok(Self {
            id: l.id,
            user_id: l.user_id,
            url: l.url,
        })
    }
}

impl Model {
    pub fn into_set(self) -> ActiveModel {
        ActiveModel {
            id: Set(self.id),
            user_id: Set(self.user_id),
            url: Set(self.url),
        }
    }
}
