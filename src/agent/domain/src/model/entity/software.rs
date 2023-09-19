use alice_architecture::IAggregateRoot;
use serde::{Deserialize, Serialize};

#[derive(Default, Deserialize, Serialize, Clone, Eq, Debug, IAggregateRoot)]
pub struct SoftwareInstallOptions {
    pub parameters: Vec<String>,
    pub version: String,
    pub name: String,
}

impl PartialEq for SoftwareInstallOptions {
    fn eq(&self, other: &Self) -> bool {
        let mut parameters = self.parameters.clone();
        parameters.sort();
        let mut other_parameters = other.parameters.clone();
        other_parameters.sort();
        let parameters = parameters.join("+");
        let other_parameters = other_parameters.join("+");
        parameters.as_str() == other_parameters.as_str()
            && self.version == other.version
            && self.name == other.name
    }
}
