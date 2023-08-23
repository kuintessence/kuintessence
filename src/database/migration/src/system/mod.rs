use sea_orm_migration::{sea_orm::Database, *};
mod m20220705_1439_create_table;
mod m20230213_1401_add_billing_system;
mod m20230217_1522_add_user_webhook;
pub struct Migrator;
#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20220705_1439_create_table::Migration),
            Box::new(m20230213_1401_add_billing_system::Migration),
            Box::new(m20230217_1522_add_user_webhook::Migration),
        ]
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
