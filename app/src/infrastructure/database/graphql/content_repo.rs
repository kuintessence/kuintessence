use std::sync::Arc;

use graphql_client::GraphQLQuery;
use reqwest::Client;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.gql",
    query_path = "graphql/query.gql",
    response_derives = "Debug, Serialize, Deserialize, Clone"
)]
pub struct GetTarById;

pub struct ContentRepository {
    pub client: Arc<Client>,
    pub url: String,
}

impl ContentRepository {
    #[inline]
    pub fn new(client: Arc<Client>, url: String) -> Self {
        Self { client, url }
    }
}
