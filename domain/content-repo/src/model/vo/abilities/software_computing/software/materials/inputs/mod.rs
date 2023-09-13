mod argument;
mod environment;
mod filesome_input;

#[rustfmt::skip]
pub use {
    argument::Argument,
    environment::Environment,
    filesome_input::FilesomeInput
};

pub(in crate::model) fn default_value_format() -> String {
    "{{}}".to_string()
}
