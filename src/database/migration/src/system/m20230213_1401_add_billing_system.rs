use database_model::system::prelude::*;
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
        "m20230213_1401_add_billing_system"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let stmts = vec![
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
                    .name("FK_ClusterIdSettings_Cluster")
                    .from(ClusterIdSettingsEntity, ClusterIdSettingsColumn::ClusterId)
                    .to(ClusterEntity, ClusterColumn::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .on_update(ForeignKeyAction::Cascade)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_foreign_key(
                sea_query::ForeignKey::drop()
                    .name("FK_ClusterIdSettings_Cluster")
                    .table(ClusterIdSettingsEntity)
                    .to_owned(),
            )
            .await?;

        let stmts = vec![
            get_seaorm_drop_stmt(FlowInstanceBillingEntity),
            get_seaorm_drop_stmt(NodeInstanceBillingEntity),
            get_seaorm_drop_stmt(ClusterIdSettingsEntity),
        ];

        for stmt in stmts {
            manager.drop_table(stmt.to_owned()).await?;
        }

        Ok(())
    }
}
