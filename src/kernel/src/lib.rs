pub mod exceptions;
#[cfg(test)]
pub mod mock;
pub mod models;
pub mod repository;
pub mod service;
#[cfg_attr(not(debug_assertions), cfg(feature = "implements"))]
pub mod services;

pub mod utils {
    pub type Anyhow = anyhow::Result<()>;
    pub use anyhow::Result as AnyhowResult;
    pub use anyhow::{anyhow, bail};
    pub use async_trait::async_trait;
    pub use derive_builder::Builder;
    pub use serde::{Deserialize, Serialize};
    pub use std::sync::Arc;
    pub use uuid::Uuid;
}

pub mod prelude {
    pub use crate::{
        exceptions::prelude::*, models::prelude::*, repository::prelude::*, service::prelude::*,
        services::prelude::*, utils::*,
    };
    pub use alice_architecture::GenericError::{
        Infrastructure as InfrastructureError, Logic as LogicError, Specific as SpecificError,
    };
}
