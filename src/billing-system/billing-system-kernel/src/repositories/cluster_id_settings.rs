use crate::prelude::*;

#[async_trait::async_trait]
pub trait IClusterIdSettingsRepository {
    async fn get_by_cluster_id(&self, id: &str) -> anyhow::Result<ClusterIdSettings>;
}
