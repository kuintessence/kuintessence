use serde::{Deserialize, Serialize};

#[derive(Default, Serialize, Deserialize, Debug)]
pub enum FileTransferStatus {
    Start,
    Stop,
    Pause,
    Continue,
    #[default]
    Unknown,
}
