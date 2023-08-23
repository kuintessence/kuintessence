use crate::prelude::*;
use lib_co_repo::{
    client::IInfoGetter,
    dtos::prelude::NodeDraft,
    models::{
        command_preview::CommandPreview, package::Package,
        software_computing_usecase::SoftwareComputingUsecase,
    },
    services::package_validate::ValidateData,
};
use mockall::mock;
use std::ops::Range;

mock! {
    pub WorkflowScheduleService {}
    #[async_trait]
    impl IWorkflowScheduleService for WorkflowScheduleService {
        async fn schedule_next_nodes(
            &self,
            id: ScheduleMode
        ) -> anyhow::Result<()>;
        async fn pause_workflow(&self, id: Uuid) -> anyhow::Result<()>;
        async fn continue_workflow(&self, id: Uuid) -> anyhow::Result<()>;
        async fn terminate_workflow(&self, id: Uuid) -> anyhow::Result<()>;
        async fn debatch(
            &self,
            node_relations: &[NodeRelation],
            node_spec: &NodeSpec,
        ) -> anyhow::Result<Vec<NodeSpec>>;
    }
}

mock! {
    pub FileMoveService {}
    #[async_trait]
    impl IFileMoveService for FileMoveService {
        async fn register_move(&self, info: MoveRegistration) -> Anyhow;
        async fn do_registered_moves(&self, meta_id: Uuid) -> Anyhow;
        async fn if_possible_do_flash_upload(&self, info: &MoveRegistration) -> Anyhow;
        async fn set_all_moves_with_same_meta_id_as_failed(
            &self,
            meta_id: Uuid,
            failed_reason: &str,
        ) -> Anyhow;
        async fn set_move_as_failed(&self, move_id: Uuid, failed_reason: &str) -> Anyhow;
        async fn get_move_info(&self, move_id: Uuid) -> AnyhowResult<Option<MoveRegistration>>;
        async fn get_user_id(&self, move_id: Uuid) -> AnyhowResult<Option<Uuid>>;
        async fn get_meta_id_failed_info(&self, meta_id: Uuid) -> AnyhowResult<(bool, Option<String>)>;
        async fn remove_all_with_meta_id(&self, meta_id: Uuid) -> Anyhow;
    }
}

mock! {
    pub StorageServerDownloadDispatcherService {}
    #[async_trait]
    impl IStorageServerDownloadDispatcherService for StorageServerDownloadDispatcherService {
        async fn download(&self, meta_id: Uuid) -> Anyhow;
        async fn get_bytes(&self, meta_id: Uuid) -> AnyhowResult<Vec<u8>>;
        async fn get_text(&self, meta_id: Uuid) -> AnyhowResult<String>;
        async fn rangely_get_file(&self, meta_id: Uuid, ranges: &[Range<u64>]) -> AnyhowResult<Vec<Vec<u8>>>;
        async fn get_file_size(&self, meta_id: Uuid) -> AnyhowResult<u64>;
        async fn get_download_url(&self, meta_id: Uuid) -> AnyhowResult<String>;
    }
}

mock! {
    pub UsecaseSelectService {}
    #[async_trait]
    impl IUsecaseSelectService for UsecaseSelectService{
        async fn send_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()>;
        async fn operate_task(&self, operation: OperateTask) -> anyhow::Result<()>;
    }

}

mock! {
    pub TaskDistributionService {}
    #[async_trait]
    impl ITaskDistributionService for TaskDistributionService{
        async fn send_task(&self, task: &Task, cluster_id: Uuid) -> anyhow::Result<()>;
    }
}

mock! {
    pub ComputingUsecaseGetter {}
    #[async_trait]
    impl IInfoGetter for ComputingUsecaseGetter {
        async fn get_package(&self, content_entity_version_id: uuid::Uuid) -> anyhow::Result<Package>;
        async fn get_node_draft(
            &self,
            usecase_version_id: uuid::Uuid,
            software_version_id: uuid::Uuid,
        ) -> anyhow::Result<NodeDraft>;
        async fn get_computing_usecase(
            &self,
            software_version_id: uuid::Uuid,
            usecase_version_id: uuid::Uuid,
        ) -> anyhow::Result<SoftwareComputingUsecase>;
        async fn get_template_keys(&self, source: &str) -> anyhow::Result<Vec<String>>;
        async fn package_validate(&self, validate_data: ValidateData)
        -> anyhow::Result<CommandPreview>;
    }
}

// mock! {
//     pub FileSystemService{}
//     impl IFileSystemService for FileSystemService{}
//     #[async_trait]
//     impl IMultipartRecord for FileSystemService{
//         async fn create_multipart_record(&self, multipart: Multipart) -> Anyhow;
//         async fn complete_part_record(&self, meta_id: Uuid, part: usize, content: &[u8])
//             -> AnyhowResult<bool>;
//         async fn complete_multipart_record(&self, meta_id: Uuid) -> Anyhow;
//         async fn remove_multipart_record(&self, meta_id: Uuid) -> Anyhow;
//     }
//     #[async_trait]
//     impl ISnapshotRecord for FileSystemService{
//         async fn send_snapshot_request_msg(&self, info: SnapshotIdent) -> anyhow::Result<()>;
//         async fn get_snapshots_records(&self, node_id: Uuid, file_id: Uuid) -> AnyhowResult<Vec<SnapshotRecord>>;
//         async fn view_snapshot(&self, args: ViewSnapshot) -> AnyhowResult<Vec<u8>>;
//         async fn remove_snapshot(&self, info: SnapshotIdent) -> Anyhow;
//     }
//     #[async_trait]
//     impl IFileRecord for FileSystemService{
//         async fn update_prepared_file_ids(
//             &self,
//             old_id: Uuid,
//             new_id: Uuid,
//             node_instance_id: Uuid,
//         ) -> Anyhow;
//         async fn is_flash_upload(&self, hash: &str) -> AnyhowResult<bool>;
//         async fn record_file(&self, args: FileRecord) -> Anyhow;
//     }
//     #[async_trait]
//     impl IRealtime for FileSystemService{
//         async fn request_realtime(&self, info: RealTimeFileInfo) -> anyhow::Result<()>;
//         async fn send_realtime(&self, req_id: Uuid, file_content: &str) -> AnyhowResult<Vec<u8>>;
//     }
//     #[async_trait]
//     impl INetDisk for FileSystemService{
//         async fn node_instance_file(&self, file_name: &str, node_id: Uuid, meta_id: Uuid) -> Anyhow;
//         async fn flow_draft_file(&self, file_name: &str, draft_id: Uuid, meta_id: Uuid) -> Anyhow;
//         async fn net_disk_file(
//             &self,
//             file_name: &str,
//             parent_id: Option<String>,
//             meta_id: Uuid,
//         ) -> Anyhow;
//     }
//     #[async_trait]
//     impl IFileStorage for FileSystemService {
//         async fn rangely_get_file(&self, meta_id: Uuid, range: &Range<u64>) -> AnyhowResult<Vec<u8>>;
//         async fn get_file_size(&self, meta_id: Uuid) -> AnyhowResult<u64>;
//         async fn get_text_file(&self, meta_id: Uuid) -> AnyhowResult<String>;
//         async fn file_download_url(&self, meta_id: Uuid) -> AnyhowResult<String>;
//     }
// }
