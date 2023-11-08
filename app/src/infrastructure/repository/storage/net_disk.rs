use async_trait::async_trait;
use database_model::file_system;
use std::sync::atomic::Ordering;

use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};

use domain_storage::{
    model::entity::net_disk::{DirKind, FileType, NetDisk},
    repository::NetDiskRepo,
};
use sea_orm::{
    prelude::*, sea_query::OnConflict, ActiveValue::Set, Condition, DatabaseBackend, QueryTrait,
    Statement,
};

use crate::infrastructure::database::OrmRepo;

#[async_trait::async_trait]
impl ReadOnlyRepository<NetDisk> for OrmRepo {}

#[async_trait::async_trait]
impl MutableRepository<NetDisk> for OrmRepo {
    async fn insert(&self, entity: &NetDisk) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        // Use user_id and user_id + 1 as flowdraft、 flowinstance folder's root id, to avoid concurrency logic error.
        // For example, if all dirs use random uuid,
        //
        // but when there is no root dir, and two thread need to create it at the same time,
        // will cause mistakenly add two different root dir. It won't trigger the on conflict do nothing.
        // by this way, it will cause on conflict do nothing, won't lead to logic error.
        let user_id = self.user_id()?;
        let mut entity = entity.clone();
        if let Some(el1) = &entity.meta {
            if let Some(el) = &el1.dir_kind {
                match el {
                    DirKind::FlowDraft if el1.flow_draft_id.is_none() => {
                        entity.id = Uuid::from_u128(user_id.as_u128() + 1)
                    }
                    DirKind::FlowInstance if el1.flow_instance_id.is_none() => {
                        entity.id = Uuid::from_u128(user_id.as_u128() + 1)
                    }
                    _ => {}
                }
            }
        }

        let active_model = file_system::ActiveModel {
            id: Set(entity.id),
            parent_id: Set(entity.parent_id),
            name: Set(entity.name),
            is_dict: Set(entity.is_dict),
            kind: Set(entity.kind as i32),
            owner_id: Set(user_id),
            file_metadata_id: Set(entity.file_metadata_id),
            meta: Set(entity.meta.map(serde_json::to_value).transpose()?),
            ..Default::default()
        };

        let stmt = file_system::Entity::insert(active_model)
            .on_conflict(
                OnConflict::columns(vec![
                    file_system::Column::ParentId,
                    file_system::Column::Name,
                    file_system::Column::OwnerId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .on_conflict(OnConflict::column(file_system::Column::Id).do_nothing().to_owned())
            .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(entity.id)
    }

    async fn save_changed(&self) -> anyhow::Result<bool> {
        self.save_changed().await
    }
}

#[async_trait::async_trait]
impl DBRepository<NetDisk> for OrmRepo {}

#[async_trait]
impl NetDiskRepo for OrmRepo {
    async fn create_root(&self) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let user_id = self.user_id()?;
        let stmt = file_system::Entity::insert(file_system::ActiveModel {
            id: Set(user_id),
            parent_id: Set(None),
            name: Set(user_id.to_string()),
            is_dict: Set(true),
            kind: Set(FileType::Folder as i32),
            owner_id: Set(user_id),
            file_metadata_id: Set(None),
            meta: Set(None),
            ..Default::default()
        })
        .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(user_id)
    }
    async fn get_root_id(&self) -> anyhow::Result<Option<Uuid>> {
        let user_id = self.user_id()?;
        Ok(file_system::Entity::find_by_id(user_id)
            .one(self.db.get_connection())
            .await?
            .map(|el| el.id))
    }

    async fn get_flow_draft_dir_id(&self, flow_draft_id: Uuid) -> anyhow::Result<Option<Uuid>> {
        let mut sql = String::from("SELECT * FROM file_system");
        sql.push_str(" WHERE meta ->> 'dirKind' = 'flowDraft'");
        sql.push_str(" AND meta ->> 'flowDraftId' = $1");
        sql.push_str(" AND owner_id = $2");
        Ok(file_system::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                &sql,
                vec![flow_draft_id.to_string().into(), self.user_id()?.into()],
            ))
            .one(self.db.get_connection())
            .await?
            .map(|el| el.id))
    }

    async fn get_node_instance_dir_id(&self, node_instance: Uuid) -> anyhow::Result<Option<Uuid>> {
        let mut sql = String::from("SELECT * FROM file_system");
        sql.push_str(" WHERE meta ->> 'dirKind' = 'nodeInstance'");
        sql.push_str(" AND meta ->> 'nodeInstanceId' = $1");
        Ok(file_system::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                &sql,
                vec![node_instance.to_string().into()],
            ))
            .one(self.db.get_connection())
            .await?
            .map(|el| el.id))
    }

    async fn get_flow_instance_dir_id(&self, flow_instance: Uuid) -> anyhow::Result<Option<Uuid>> {
        let mut sql = String::from("SELECT * FROM file_system");
        sql.push_str(" WHERE meta ->> 'dirKind' = 'flowInstance'");
        sql.push_str(" AND meta ->> 'flowInstanceId' = $1");
        Ok(file_system::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                &sql,
                vec![flow_instance.to_string().into()],
            ))
            .one(self.db.get_connection())
            .await?
            .map(|el| el.id))
    }

    async fn is_same_pid_fname_exists(
        &self,
        mut parent_id: Option<Uuid>,
        file_name: &str,
    ) -> anyhow::Result<bool> {
        let user_id = self.user_id()?;
        parent_id = parent_id.or(Some(user_id));
        Ok(file_system::Entity::find()
            .filter(
                Condition::all()
                    .add(file_system::Column::ParentId.eq(parent_id))
                    .add(file_system::Column::Name.eq(file_name))
                    .add(file_system::Column::OwnerId.eq(user_id)),
            )
            .one(self.db.get_connection())
            .await?
            .is_some())
    }

    async fn get_flow_draft_root_id(&self) -> anyhow::Result<Option<Uuid>> {
        let mut sql = String::from("SELECT * FROM file_system");
        sql.push_str(" WHERE meta ->> 'dirKind' = 'flowDraft'");
        sql.push_str(" AND NOT meta ? 'flowDraftId'");
        sql.push_str(" AND owner_id = $1");
        Ok(file_system::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                &sql,
                vec![self.user_id()?.into()],
            ))
            .one(self.db.get_connection())
            .await?
            .map(|el| el.id))
    }

    async fn get_flow_instance_root_id(&self) -> anyhow::Result<Option<Uuid>> {
        let mut sql = String::from("SELECT * FROM file_system");
        sql.push_str(" WHERE meta ->> 'dirKind' = 'flowInstance'");
        sql.push_str(" AND NOT meta ? 'flowInstanceId'");
        sql.push_str(" AND owner_id = $1");
        let user_id = self.user_id()?;
        Ok(file_system::Entity::find()
            .from_raw_sql(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                &sql,
                vec![user_id.into()],
            ))
            .one(self.db.get_connection())
            .await?
            .map(|el| el.id))
    }
}
