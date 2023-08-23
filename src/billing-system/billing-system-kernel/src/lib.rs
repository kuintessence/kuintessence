pub mod models;
pub mod repositories;
pub mod service;
pub mod services;


pub mod prelude{
    pub use super::models::prelude::*;
    pub use super::repositories::prelude::*;
    pub use super::service::prelude::*;
    pub use super::services::prelude::*;
}
