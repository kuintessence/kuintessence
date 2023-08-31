pub mod cache;
pub mod content_extractor;
pub mod meta;
pub mod mover;
pub mod multipart;
pub mod net_disk;
pub mod realtime;
pub mod server_download_dispatcher;
pub mod server_upload_dispatcher;
pub mod snapshot;
pub mod storage_server_resource;
pub mod text;

pub mod prelude {
    #[rustfmt::skip]
    pub use super::{
        cache::LocalCacheServiceImpl,
        content_extractor::ContentExtractorServiceImpl,
        meta::MetaStorageServiceImpl,
        mover::FileMoveServiceImpl,
        multipart::MultipartServiceImpl,
        net_disk::NetDiskServiceImpl,
        realtime::RealtimeServiceImpl,
        server_download_dispatcher::StorageServerDownloadDispatcherServiceImpl,
        server_upload_dispatcher::StorageServerUploadDispatcherServiceImpl,
        snapshot::SnapshotServiceImpl,
        storage_server_resource::StorageServerResourceServiceImpl,
        text::TextStorageServiceImpl,
    };
}
