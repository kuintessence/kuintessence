#[cfg_attr(not(debug_assertions), cfg(feature = "co-repo-client"))]
pub mod client;
pub mod dtos;
pub mod exceptions;
pub mod models;
pub mod services;

pub mod prelude {
    pub use super::exceptions::*;
    pub use super::models::prelude::*;
    pub use super::services::prelude::*;
}
