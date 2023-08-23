use serde::Serialize;

#[derive(Serialize)]
pub struct Formula {
    pub p_cpu: String,
    pub p_memory: String,
    pub p_storage: String,
    pub p_cpu_time: String,
    pub p_wall_time: String,
    pub p_total: String,
}
