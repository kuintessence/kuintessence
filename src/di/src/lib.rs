pub use alice_di_macro::*;
pub trait IServiceProvider<T> {
    fn provide(&self) -> T;
}

#[async_trait::async_trait]
pub trait IAsyncServiceProvider<T> {
    async fn provide_async(&self) -> T;
}

pub type Consumer<'async_fn> =
    std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + 'async_fn>>;
