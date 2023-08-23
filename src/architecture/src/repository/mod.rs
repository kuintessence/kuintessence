//! 对仓储层的抽象
#[cfg(all(feature = "etcd"))]
mod default_implement;
make_re_export!(lease_repository, mutable_repository, read_only_repository);

/// 对使用数据库仓储的抽象，带有可读仓储和可写仓储
#[async_trait::async_trait]
pub trait IDBRepository<T>: IReadOnlyRepository<T> + IMutableRepository<T>
where
    T: std::marker::Send + crate::model::IAggregateRoot,
{
}

/// 对使用带有租约的数据库进行抽象，带有租约仓储、可读仓储和可写仓储
#[async_trait::async_trait]
pub trait ILeaseDBRepository<T>: IDBRepository<T> + ILeaseRepository<T>
where
    T: std::marker::Send + crate::model::IAggregateRoot,
{
}
