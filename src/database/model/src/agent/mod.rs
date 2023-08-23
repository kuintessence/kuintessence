pub mod installed_software;
pub mod local_software_source;
pub mod software_block_list;
pub mod software_install_history;
pub mod software_source;
pub mod prelude {
    pub use super::{
        installed_software::prelude::*, local_software_source::prelude::*,
        software_block_list::prelude::*, software_install_history::prelude::*,
        software_source::prelude::*,
    };
}
