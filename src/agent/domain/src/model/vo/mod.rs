//! Value objects

mod file;
pub mod job;
mod software;
mod task;

#[rustfmt::skip]
pub use self::{
    file::FileTransferStatus,
    job::Job,
    software::LocalSoftware,
    task::TaskDisplayType,
};
