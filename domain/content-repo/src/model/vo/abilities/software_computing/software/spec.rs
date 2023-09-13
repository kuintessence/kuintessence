use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(JsonSchema, Serialize, Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
/// 软件规格
pub enum SoftwareSpec {
    Spack {
        /// spack 软件名
        name: String,
        /// 参数列表
        argument_list: Vec<String>,
    },
    Singularity {
        /// singularity 镜像名
        image: String,
        /// tag
        tag: String,
    },
}
