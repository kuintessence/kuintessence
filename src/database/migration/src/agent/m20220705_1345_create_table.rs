use database_model::agent::prelude::*;
use sea_orm_migration::prelude::*;
pub struct Migration;
impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m20220705_1345_create_table"
    }
}
#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                sea_query::Table::create()
                    .table(SoftwareInstallHistoryEntity)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(SoftwareInstallHistoryColumn::Id)
                            .uuid()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(SoftwareInstallHistoryColumn::Name).string().not_null())
                    .col(ColumnDef::new(SoftwareInstallHistoryColumn::Status).integer().not_null())
                    .col(ColumnDef::new(SoftwareInstallHistoryColumn::Log).text().not_null())
                    .col(
                        ColumnDef::new(SoftwareInstallHistoryColumn::StartTime)
                            .date_time()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SoftwareInstallHistoryColumn::EndTime)
                            .date_time()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(SoftwareInstallHistoryColumn::RequestUserId)
                            .uuid()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await
    }

    // async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
    //     manager
    //         .drop_table( ... )
    //         .await
    // }
}
