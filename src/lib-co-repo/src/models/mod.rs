pub mod abilities;
pub mod command_preview;
pub mod manifest;
pub mod package;
pub mod software_computing_usecase;

pub mod prelude {
    pub use super::abilities::prelude::*;
    pub use super::command_preview::*;
    pub use super::manifest::*;
    pub use super::package::*;
    pub use super::software_computing_usecase::*;
}

#[cfg(test)]
mod tests {
    use crate::prelude::*;

    #[test]
    fn generate_schemas() {
        let manifest_schema =
            serde_json::to_string_pretty(&schemars::schema_for!(Manifest)).unwrap();
        let software_schema =
            serde_json::to_string_pretty(&schemars::schema_for!(SoftwareMaterial)).unwrap();
        let usecase_spec_schema =
            serde_json::to_string_pretty(&schemars::schema_for!(UsecaseMaterial)).unwrap();
        std::fs::write("manifest_schema.json", manifest_schema).unwrap();
        std::fs::write("software_schema.json", software_schema).unwrap();
        std::fs::write("usecase_spec_schema.json", usecase_spec_schema).unwrap();
    }
}
