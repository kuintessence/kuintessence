use sea_orm::DatabaseConnection;

#[derive(Clone)]
pub struct Database {
    connection: DatabaseConnection,
}

impl Database {
    pub async fn new(dburl: &str) -> Self {
        let connection =
            sea_orm::Database::connect(dburl).await.expect("Could not connect to database");
        Database { connection }
    }

    pub fn get_connection(&self) -> &DatabaseConnection {
        &self.connection
    }
}
