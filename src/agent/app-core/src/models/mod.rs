use alice_architecture::model::IAggregateRoot;
use serde::*;
use std::collections::HashMap;
pub mod file;
pub mod job;
pub mod software;
pub mod task;
pub use self::file::*;
pub use self::job::*;
pub use self::software::*;
pub use self::task::*;
