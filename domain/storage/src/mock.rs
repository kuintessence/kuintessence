use crate::{
    command::{FileUploadCommand, RequestSnapshotCommand},
    model::{
        entity::{
            FileMeta, FileStorage, MoveRegistration, Multipart, NetDisk, Snapshot, TextStorage,
        },
        vo::HashAlgorithm,
    },
    repository::{
        FileMetaRepo, FileStorageRepo, MoveRegistrationRepo, MultipartRepo, NetDiskRepo,
        SnapshotRepo, TextStorageRepo,
    },
};
use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate,
    repository::{
        DBRepository, LeaseDBRepository, LeaseRepository, MutableRepository, ReadOnlyRepository,
    },
};
use async_trait::async_trait;
use mockall::mock;
use uuid::Uuid;

mock! {
    pub SnapshotMqProducer {}
    #[async_trait]
    impl MessageQueueProducerTemplate<RequestSnapshotCommand> for SnapshotMqProducer {
        async fn send_object(&self, content: &RequestSnapshotCommand, topic: &str) -> anyhow::Result<()>;
    }
}

mock! {
    pub FileUploadSender {}
    #[async_trait]
    impl MessageQueueProducerTemplate<FileUploadCommand> for FileUploadSender {
        async fn send_object(&self, content: &FileUploadCommand, topic: &str) -> anyhow::Result<()>;
    }
}

mock! {
    pub MoveRegistrationRepo {}
    #[async_trait]
    impl MoveRegistrationRepo for MoveRegistrationRepo{
        async fn get_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<Vec<MoveRegistration>>;
        async fn get_one_by_key_regex(
            &self,
            key_regex: &str,
        ) -> anyhow::Result<Option<MoveRegistration>>;
        async fn remove_all_by_key_regex(&self, key_regex: &str) -> anyhow::Result<()>;
    }
    impl LeaseDBRepository<MoveRegistration> for MoveRegistrationRepo {}
    impl DBRepository<MoveRegistration> for MoveRegistrationRepo {}
    impl ReadOnlyRepository<MoveRegistration> for MoveRegistrationRepo {}
    impl MutableRepository<MoveRegistration> for MoveRegistrationRepo {}
    impl LeaseRepository<MoveRegistration> for MoveRegistrationRepo {}
}

mock! {
    pub SnapshotRepo {}
    #[async_trait]
    impl SnapshotRepo for SnapshotRepo {
        async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<Snapshot>;
        async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Snapshot>>;
        async fn get_all_by_key_regex(&self, regex: &str) -> anyhow::Result<Vec<Snapshot>>;
    }
    impl LeaseDBRepository<Snapshot> for SnapshotRepo {}
    impl DBRepository<Snapshot> for SnapshotRepo {}
    impl ReadOnlyRepository<Snapshot> for SnapshotRepo {}
    impl MutableRepository<Snapshot> for SnapshotRepo {}
    impl LeaseRepository<Snapshot> for SnapshotRepo {}
}

mock! {
    pub NetDiskRepo {}
    #[async_trait]
    impl NetDiskRepo for NetDiskRepo {
        async fn get_root_id(&self) -> anyhow::Result<Option<Uuid>>;
        async fn get_flow_draft_dir_id(&self, flow_draft_id: Uuid) -> anyhow::Result<Option<Uuid>>;
        async fn get_node_instance_dir_id(&self, node_instance: Uuid) -> anyhow::Result<Option<Uuid>>;
        async fn get_flow_instance_dir_id(&self, flow_instance: Uuid) -> anyhow::Result<Option<Uuid>>;
        async fn get_flow_draft_root_id(&self) -> anyhow::Result<Option<Uuid>>;
        async fn get_flow_instance_root_id(&self) -> anyhow::Result<Option<Uuid>>;
        async fn is_same_pid_fname_exists(
            &self,
            parent_id: Option<Uuid>,
            file_name: &str,
        ) -> anyhow::Result<bool>;
        async fn create_root(&self) -> anyhow::Result<Uuid>;
    }
    impl DBRepository<NetDisk> for NetDiskRepo {}
    impl ReadOnlyRepository<NetDisk> for NetDiskRepo {}
    impl MutableRepository<NetDisk> for NetDiskRepo {}
}

mock! {
    pub FileStorageRepo {}
    #[async_trait]
    impl FileStorageRepo for FileStorageRepo {
        async fn get_by_storage_server_id_and_meta_id(
            &self,
            storage_server_id: Uuid,
            meta_id: Uuid,
        ) -> anyhow::Result<String>;
    }
    impl DBRepository<FileStorage> for FileStorageRepo {}
    impl ReadOnlyRepository<FileStorage> for FileStorageRepo {}
    impl MutableRepository<FileStorage> for FileStorageRepo {}
}

mock! {
    pub FileMetaRepo {}
    #[async_trait]
    impl FileMetaRepo for FileMetaRepo {
        async fn get_by_hash_and_algorithm(
            &self,
            hash: &str,
            hash_algorithm: &HashAlgorithm,
        ) -> anyhow::Result<Option<FileMeta>>;
    }
    impl DBRepository<FileMeta> for FileMetaRepo {}
    impl ReadOnlyRepository<FileMeta> for FileMetaRepo {}
    impl MutableRepository<FileMeta> for FileMetaRepo {}
}

mock! {
    pub MultipartRepo {}
    #[async_trait]
    impl MultipartRepo for MultipartRepo {
        async fn get_one_by_key_regex(&self, regex: &str) -> anyhow::Result<Option<Multipart>>;
        async fn delete_by_key_regex(&self, regex: &str) -> anyhow::Result<()>;
    }
    impl LeaseDBRepository<Multipart> for MultipartRepo {}
    impl DBRepository<Multipart> for MultipartRepo {}
    impl ReadOnlyRepository<Multipart> for MultipartRepo {}
    impl MutableRepository<Multipart> for MultipartRepo {}
    impl LeaseRepository<Multipart> for MultipartRepo {}
}

mock! {
    pub TextStorageRepo {}
    #[async_trait]
    impl TextStorageRepo for TextStorageRepo {
        async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>>;
        async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
    }
    impl DBRepository<TextStorage> for TextStorageRepo {}
    impl ReadOnlyRepository<TextStorage> for TextStorageRepo {}
    impl MutableRepository<TextStorage> for TextStorageRepo {}
}
