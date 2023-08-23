pub mod argument;
pub mod environment;
pub mod filesome_input;

pub mod prelude {
    pub use super::argument::*;
    pub use super::environment::*;
    pub use super::filesome_input::*;
}

pub(in crate::models) fn default_value_format() -> String {
    "{{}}".to_string()
}
