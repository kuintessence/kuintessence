use graphql_client::GraphQLQuery;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/co-repo-sdl.gql",
    query_path = "graphql/co-repo-query.gql",
    response_derives = "Debug, Serialize, Deserialize, Clone"
)]
pub struct GetTarById;
