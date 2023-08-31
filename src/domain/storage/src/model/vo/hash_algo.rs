use alice_architecture::utils::*;

/// Hash algorithm.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", tag = "hashAlgorithm", content = "hash")]
pub enum HashAlgorithm {
    #[default]
    Blake3,
}

impl std::fmt::Display for HashAlgorithm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Blake3 => write!(f, "blake3"),
        }
    }
}

impl std::str::FromStr for HashAlgorithm {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "blake3" => Ok(Self::Blake3),
            _ => bail!("{s} can't be transformed to HashAlgorithm"),
        }
    }
}
