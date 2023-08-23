use sea_orm_migration::{sea_orm::Database, *};
mod m20220705_1345_create_table;
mod m20220705_1438_create_table;

pub struct Migrator;
#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![Box::new(m20220705_1438_create_table::Migration)]
    }
}
impl Migrator {
    pub async fn migration_up(db_con: &str) {
        if let Err(e) = Migrator::up(&Database::connect(db_con).await.unwrap(), None).await {
            eprintln!("{}", e);
        }
    }
    pub async fn migration_down(db_con: &str) {
        if let Err(e) = Migrator::down(&Database::connect(db_con).await.unwrap(), None).await {
            eprintln!("{}", e);
        }
    }
}
