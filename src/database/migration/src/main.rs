mod agent;
mod system;
enum ActionEnum {
    Up,
    Down,
}
enum DbEnum {
    System(ActionEnum, String),
    Agent(ActionEnum, String),
}
const CONFIG_ENV_PREFIX: &str = "MIGRATION";
const CONFIG_ENV_SEPARATOR: &str = "__";
const CONFIG: &str = "config";
const DB_KEY: &str = "migrate.db";
const DB_SYSTEM: &str = "system";
const DB_AGENT: &str = "agent";
const ACTION_KEY: &str = "migrate.action";
const ACTION_UP: &str = "up";
const ACTION_DOWN: &str = "down";
const DB_CON: &str = "migrate.dbcon";

#[tokio::main]
async fn main() {
    let config = config::Config::builder()
        .add_source(
            config::File::with_name(CONFIG).required(false).format(config::FileFormat::Yaml),
        )
        .add_source(
            config::Environment::with_prefix(CONFIG_ENV_PREFIX).separator(CONFIG_ENV_SEPARATOR),
        )
        .build()
        .unwrap();
    let action = config.get_string(ACTION_KEY).unwrap();
    let db = config.get_string(DB_KEY).unwrap();
    let db_con = config.get_string(DB_CON).unwrap();
    let action = match action.as_str() {
        ACTION_UP => ActionEnum::Up,
        ACTION_DOWN => ActionEnum::Down,
        _ => {
            eprintln!(
                "{} 的值只能是 {} 或 {}，现在是 {}",
                ACTION_KEY, ACTION_UP, ACTION_DOWN, action
            );
            return;
        }
    };
    let db = match db.as_str() {
        DB_AGENT => DbEnum::Agent(action, db_con),
        DB_SYSTEM => DbEnum::System(action, db_con),
        _ => {
            eprintln!(
                "{} 的值只能是 {} 或 {}，现在是 {}",
                DB_KEY, DB_AGENT, DB_SYSTEM, db
            );
            return;
        }
    };
    exe_db_action(db).await;
}

async fn exe_db_action(db: DbEnum) {
    match db {
        DbEnum::Agent(action, db_con) => match action {
            ActionEnum::Up => agent::Migrator::migration_up(&db_con).await,
            ActionEnum::Down => agent::Migrator::migration_down(&db_con).await,
        },
        DbEnum::System(action, db_con) => match action {
            ActionEnum::Up => system::Migrator::migration_up(&db_con).await,
            ActionEnum::Down => system::Migrator::migration_down(&db_con).await,
        },
    };
}
