/// 在主服务运行时的后台服务
#[async_trait::async_trait]
pub trait IBackgroundService {
    /// 启动方法
    async fn run(&self);
}
