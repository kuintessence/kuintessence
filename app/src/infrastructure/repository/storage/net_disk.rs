use async_trait::async_trait;
use std::sync::atomic::Ordering;

use alice_architecture::repository::{DBRepository, MutableRepository, ReadOnlyRepository};

use database_model::system::prelude::*;
use domain_storage::{
    model::entity::net_disk::{DirKind, FileType, NetDisk},
    repository::NetDiskRepo,
};
use sea_orm::{
    prelude::*,
    sea_query::OnConflict,
    ActiveValue::{NotSet, Set},
    Condition, DatabaseBackend, QueryTrait, Statement,
};

use crate::infrastructure::database::SeaOrmDbRepository;

#[async_trait::async_trait]
impl ReadOnlyRepository<NetDisk> for SeaOrmDbRepository {}

#[async_trait::async_trait]
impl MutableRepository<NetDisk> for SeaOrmDbRepository {
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

        let mut model = FileSystemModel::try_from(entity.to_owned())?;
        model.owner_id = user_id;

        let active_model = model.into_insert();

        let stmt = FileSystemEntity::insert(active_model)
            .on_conflict(
                OnConflict::columns(vec![
                    FileSystemColumn::ParentId,
                    FileSystemColumn::Name,
                    FileSystemColumn::OwnerId,
                ])
                .do_nothing()
                .to_owned(),
            )
            .on_conflict(OnConflict::column(FileSystemColumn::Id).do_nothing().to_owned())
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
impl DBRepository<NetDisk> for SeaOrmDbRepository {}

#[async_trait]
impl NetDiskRepo for SeaOrmDbRepository {
    async fn create_root(&self) -> anyhow::Result<Uuid> {
        let mut stmts = self.statements.lock().await;
        let user_id = self.user_id()?;
        let stmt = FileSystemEntity::insert(FileSystemActiveModel {
            id: Set(user_id),
            parent_id: Set(None),
            name: Set(user_id.to_string()),
            is_dict: Set(true),
            kind: Set(FileType::Folder as i32),
            owner_id: Set(user_id),
            created_time: NotSet,
            file_metadata_id: Set(None),
            meta: Set(None),
        })
        .build(self.db.get_connection().get_database_backend());
        stmts.push(stmt);
        self.can_drop.store(false, Ordering::Relaxed);
        Ok(user_id)
    }
    async fn get_root_id(&self) -> anyhow::Result<Option<Uuid>> {
        let user_id = self.user_id()?;
        Ok(FileSystemEntity::find_by_id(user_id)
            .one(self.db.get_connection())
            .await?
            .map(|el| el.id))
    }

    async fn get_flow_draft_dir_id(&self, flow_draft_id: Uuid) -> anyhow::Result<Option<Uuid>> {
        let mut sql = String::from("SELECT * FROM file_system");
        sql.push_str(" WHERE meta ->> 'dirKind' = 'flowDraft'");
        sql.push_str(" AND meta ->> 'flowDraftId' = $1");
        sql.push_str(" AND owner_id = $2");
        Ok(FileSystemEntity::find()
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
        Ok(FileSystemEntity::find()
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
        Ok(FileSystemEntity::find()
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
        Ok(FileSystemEntity::find()
            .filter(
                Condition::all()
                    .add(FileSystemColumn::ParentId.eq(parent_id))
                    .add(FileSystemColumn::Name.eq(file_name))
                    .add(FileSystemColumn::OwnerId.eq(user_id)),
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
        Ok(FileSystemEntity::find()
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
        Ok(FileSystemEntity::find()
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
