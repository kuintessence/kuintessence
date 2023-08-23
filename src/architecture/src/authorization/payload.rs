use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Default, Debug, Clone)]
pub struct UserInfo {
    pub user_id: String,
    pub preferred_username: String,
    pub resource_access: HashMap<String, ResourceAccessItem>,
}

impl UserInfo {
    pub fn new(payload: Payload) -> Self {
        Self {
            user_id: payload.sub,
            preferred_username: payload.preferred_username,
            resource_access: payload.resource_access,
        }
    }
}

/// 携带用户信息的 Payload，
/// 默认从 JWT 的 Payload 块中读取
#[derive(Deserialize, Default, Clone)]
pub struct Payload {
    /// 签发地
    pub iss: String,
    /// 用户 uuid
    pub sub: String,
    /// 用户名
    pub preferred_username: String,
    /// 用户访问资源使用的角色表，键：资源名，值：角色列表
    pub resource_access: HashMap<String, ResourceAccessItem>,
}

/// 用户访问特定资源使用的角色表
#[derive(Deserialize, Default, Debug, Clone)]
pub struct ResourceAccessItem {
    /// 角色列表
    pub roles: Vec<String>,
}
