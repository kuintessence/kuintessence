/// 聚合根标记特性
pub trait IAggregateRoot {}

/// 分页结构体
pub struct Pagination {
    /// 分页大小
    pub page_size: i32,
    /// 分页页码
    pub page_index: i32,
}

/// 分页处理结果
pub struct PaginationResult<T> {
    /// 页面元素列表
    pub items: Vec<T>,
    /// 总共元素个数
    pub total: i32,
}
