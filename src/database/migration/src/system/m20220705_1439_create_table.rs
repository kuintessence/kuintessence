use database_model::{
    agent::prelude::{InstalledSoftwareEntity, SoftwareBlockListEntity, SoftwareSourceEntity},
    sea_orm::{ConnectionTrait, Statement},
    system::prelude::*,
};
use sea_orm_migration::{
    prelude::*,
    sea_orm::{DbBackend, EntityTrait, Schema},
};
pub struct Migration;

fn get_seaorm_create_stmt<E: EntityTrait>(e: E) -> TableCreateStatement {
    let schema = Schema::new(DbBackend::Postgres);
    schema.create_table_from_entity(e).if_not_exists().to_owned()
}

fn get_seaorm_drop_stmt<E: EntityTrait>(e: E) -> TableDropStatement {
    Table::drop().table(e).if_exists().to_owned()
}

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20220705_1439_create_table"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let stmts = vec![
            get_seaorm_create_stmt(FlowTemplateEntity),
            get_seaorm_create_stmt(FlowDraftEntity),
            get_seaorm_create_stmt(RegionEntity),
            get_seaorm_create_stmt(AvailableZoneEntity),
            get_seaorm_create_stmt(FlowInstanceEntity),
            get_seaorm_create_stmt(ClusterEntity),
            get_seaorm_create_stmt(UserResourceEntity),
            get_seaorm_create_stmt(ClusterResourceEntity),
            get_seaorm_create_stmt(NodeInstanceEntity),
            get_seaorm_create_stmt(FileTransmitEntity),
            get_seaorm_create_stmt(WorkOrderEntity),
            get_seaorm_create_stmt(DictionaryEntity),
            get_seaorm_create_stmt(DictionaryValueEntity),
            get_seaorm_create_stmt(UserLogEntity),
            get_seaorm_create_stmt(FileMetadataEntity),
            get_seaorm_create_stmt(FileSystemEntity),
            get_seaorm_create_stmt(StorageServerEntity),
            get_seaorm_create_stmt(FileStorageEntity),
            get_seaorm_create_stmt(NotificationEntity),
            get_seaorm_create_stmt(NodeDraftFileEntity),
            get_seaorm_create_stmt(NodeInstanceEntity),
            get_seaorm_create_stmt(SoftwareBlockListEntity),
            get_seaorm_create_stmt(SoftwareSourceEntity),
            get_seaorm_create_stmt(InstalledSoftwareEntity),
            get_seaorm_create_stmt(FlowInstanceBillingEntity),
            get_seaorm_create_stmt(NodeInstanceBillingEntity),
            get_seaorm_create_stmt(ClusterIdSettingsEntity),
        ];
        for stmt in stmts {
            manager.create_table(stmt.to_owned()).await?;
        }
        manager
            .create_foreign_key(
                sea_query::ForeignKey::create()
                    .name("FK_FileTransmit_FileMetadata")
                    .from(FileTransmitEntity, FileTransmitColumn::FileMetadataId)
                    .to(FileMetadataEntity, FileMetadataColumn::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .on_update(ForeignKeyAction::Cascade)
                    .to_owned(),
            )
            .await?;
        manager
            .create_foreign_key(
                sea_query::ForeignKey::create()
                    .name("FK_From_FileTransmit_StorageServer")
                    .from(FileTransmitEntity, FileTransmitColumn::FromStorageServerId)
                    .to(StorageServerEntity, StorageServerColumn::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .on_update(ForeignKeyAction::Cascade)
                    .to_owned(),
            )
            .await?;
        manager
            .create_foreign_key(
                sea_query::ForeignKey::create()
                    .name("FK_To_FileTransmit_StorageServer")
                    .from(FileTransmitEntity, FileTransmitColumn::ToStorageServerId)
                    .to(StorageServerEntity, StorageServerColumn::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .on_update(ForeignKeyAction::Cascade)
                    .to_owned(),
            )
            .await?;
        manager
            .create_foreign_key(
                sea_query::ForeignKey::create()
                    .name("FK_From_FileTransmit_NodeInstance")
                    .from(FileTransmitEntity, FileTransmitColumn::FromNodeInstanceId)
                    .to(NodeInstanceEntity, NodeInstanceColumn::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .on_update(ForeignKeyAction::Cascade)
                    .to_owned(),
            )
            .await?;
        manager
            .create_foreign_key(
                sea_query::ForeignKey::create()
                    .name("FK_To_FileTransmit_NodeInstance")
                    .from(FileTransmitEntity, FileTransmitColumn::ToNodeInstanceId)
                    .to(NodeInstanceEntity, NodeInstanceColumn::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .on_update(ForeignKeyAction::Cascade)
                    .to_owned(),
            )
            .await?;
        let statement = Statement::from_string(
            DbBackend::Postgres,
            vec![
                r#"ALTER TABLE "public"."file_storage""#,
                r#"ADD UNIQUE ("file_metadata_id", "storage_server_id")"#,
            ]
            .join(" "),
        );
        manager.get_connection().execute(statement).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let statement = Statement::from_string(
            DbBackend::Postgres,
            vec![
                r#"ALTER TABLE "public"."file_storage""#,
                r#"DROP CONSTRAINT file_storage_file_metadata_id_storage_server_id_key"#,
            ]
            .join(" "),
        );
        manager.get_connection().execute(statement).await?;
        manager
            .drop_foreign_key(
                sea_query::ForeignKey::drop()
                    .name("FK_From_FileTransmit_StorageServer")
                    .table(FileTransmitEntity)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_foreign_key(
                sea_query::ForeignKey::drop()
                    .name("FK_To_FileTransmit_StorageServer")
                    .table(FileTransmitEntity)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_foreign_key(
                sea_query::ForeignKey::drop()
                    .name("FK_To_FileTransmit_NodeInstance")
                    .table(FileTransmitEntity)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_foreign_key(
                sea_query::ForeignKey::drop()
                    .name("FK_From_FileTransmit_NodeInstance")
                    .table(FileTransmitEntity)
                    .to_owned(),
            )
            .await?;
        manager
            .drop_foreign_key(
                sea_query::ForeignKey::drop()
                    .name("FK_FileTransmit_FileMetadata")
                    .table(FileTransmitEntity)
                    .to_owned(),
            )
            .await?;

        let stmts = vec![
            get_seaorm_drop_stmt(SoftwareSourceEntity),
            get_seaorm_drop_stmt(InstalledSoftwareEntity),
            get_seaorm_drop_stmt(SoftwareBlockListEntity),
            get_seaorm_drop_stmt(NodeInstanceEntity),
            get_seaorm_drop_stmt(NodeDraftFileEntity),
            get_seaorm_drop_stmt(NotificationEntity),
            get_seaorm_drop_stmt(FileStorageEntity),
            get_seaorm_drop_stmt(StorageServerEntity),
            get_seaorm_drop_stmt(FileSystemEntity),
            get_seaorm_drop_stmt(FileMetadataEntity),
            get_seaorm_drop_stmt(UserLogEntity),
            get_seaorm_drop_stmt(DictionaryValueEntity),
            get_seaorm_drop_stmt(DictionaryEntity),
            get_seaorm_drop_stmt(WorkOrderEntity),
            get_seaorm_drop_stmt(FileTransmitEntity),
            get_seaorm_drop_stmt(NodeInstanceEntity),
            get_seaorm_drop_stmt(ClusterResourceEntity),
            get_seaorm_drop_stmt(UserResourceEntity),
            get_seaorm_drop_stmt(ClusterEntity),
            get_seaorm_drop_stmt(FlowInstanceEntity),
            get_seaorm_drop_stmt(AvailableZoneEntity),
            get_seaorm_drop_stmt(RegionEntity),
            get_seaorm_drop_stmt(FlowDraftEntity),
            get_seaorm_drop_stmt(FlowTemplateEntity),
        ];

        for stmt in stmts {
            manager.drop_table(stmt.to_owned()).await?;
        }

        Ok(())
    }
}
