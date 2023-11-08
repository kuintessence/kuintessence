pub mod entity;
pub mod vo;

#[cfg(test)]
mod tests {
    use super::{
        entity::package::Manifest,
        vo::abilities::software_computing::schema::{SoftwareMaterial, UsecaseMaterial},
    };

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
