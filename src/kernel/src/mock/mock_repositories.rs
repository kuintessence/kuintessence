use crate::prelude::*;
use alice_architecture::repository::{IDBRepository, IMutableRepository, IReadOnlyRepository};
use mockall::mock;

mock! {
    pub WorkflowDraftRepository {}
    #[async_trait]
    impl IReadOnlyRepository<WorkflowDraft> for WorkflowDraftRepository {
        async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WorkflowDraft>;
        async fn get_all(&self) -> anyhow::Result<Vec<WorkflowDraft>>;
    }
    #[async_trait]
    impl IMutableRepository<WorkflowDraft> for WorkflowDraftRepository {
        async fn update(&self, entity: WorkflowDraft) -> anyhow::Result<WorkflowDraft>;
        async fn insert(&self, entity: WorkflowDraft) -> anyhow::Result<WorkflowDraft>;
        async fn delete(&self, entity: WorkflowDraft) -> anyhow::Result<bool>;
        async fn delete_by_id(
            &self,
            uuid: &str,
            entity: Option<WorkflowDraft>,
        ) -> anyhow::Result<bool>;
        async fn save_changed(&self) -> anyhow::Result<bool>;
    }
}
mock! {
    pub WorkflowInstanceRepository {}
    #[async_trait]
    impl IWorkflowInstanceRepository for WorkflowInstanceRepository {
        async fn get_by_node_id(&self, node_id: Uuid) -> anyhow::Result<WorkflowInstance>;
        async fn update_node_instance_prepared_file_ids(
            &self,
            old_id: Uuid,
            new_id: Uuid,
            node_instance_id: Uuid,
        ) -> anyhow::Result<()>;
    }
    #[async_trait]
    impl IReadOnlyRepository<WorkflowInstance> for WorkflowInstanceRepository {
        async fn get_by_id(&self, uuid: &str) -> anyhow::Result<WorkflowInstance>;
        async fn get_all(&self) -> anyhow::Result<Vec<WorkflowInstance>>;
    }
    #[async_trait]
    impl IMutableRepository<WorkflowInstance> for WorkflowInstanceRepository {
        async fn update(&self, entity: WorkflowInstance) -> anyhow::Result<WorkflowInstance>;
        async fn insert(&self, entity: WorkflowInstance) -> anyhow::Result<WorkflowInstance>;
        async fn delete(&self, entity: WorkflowInstance) -> anyhow::Result<bool>;
        async fn delete_by_id(
            &self,
            uuid: &str,
            entity: Option<WorkflowInstance>,
        ) -> anyhow::Result<bool>;
        async fn save_changed(&self) -> anyhow::Result<bool>;
    }
    #[async_trait]
    impl IDBRepository<WorkflowInstance> for WorkflowInstanceRepository {}
}

mock! {
    pub NodeInstanceRepository {}
    #[async_trait]
    impl INodeInstanceRepository for NodeInstanceRepository {
        /// 根据批量父节点 id 获取所有批量子节点信息
        async fn get_node_sub_node_instances(
        &self,
        batch_parent_id: Uuid,
    ) -> anyhow::Result<Vec<NodeInstance>>;

        /// 同批次节点状态是否全部成功
        async fn is_all_same_entryment_nodes_success(&self, node_id: Uuid) -> anyhow::Result<bool>;

        /// 获取某工作流实例的正在待命的节点
        async fn get_all_workflow_instance_stand_by_nodes(
            &self,
            workflow_instance_id: Uuid,
        ) -> anyhow::Result<Vec<NodeInstance>>;

        /// 获取某工作流实例的节点
        async fn get_all_workflow_instance_nodes(
            &self,
            workflow_instance_id: Uuid,
        ) -> anyhow::Result<Vec<NodeInstance>>;

        /// 获取批量任务是第几个
        async fn get_nth_of_batch_tasks(&self, sub_node_id: Uuid) -> anyhow::Result<usize>;
    }
    #[async_trait]
    impl IReadOnlyRepository<NodeInstance> for NodeInstanceRepository {
        async fn get_by_id(&self, uuid: &str) -> anyhow::Result<NodeInstance>;
        async fn get_all(&self) -> anyhow::Result<Vec<NodeInstance>>;
    }
    #[async_trait]
    impl IMutableRepository<NodeInstance> for NodeInstanceRepository {
        async fn update(&self, entity: NodeInstance) -> anyhow::Result<NodeInstance>;
        async fn insert(&self, entity: NodeInstance) -> anyhow::Result<NodeInstance>;
        async fn delete(&self, entity: NodeInstance) -> anyhow::Result<bool>;
        async fn delete_by_id(
            &self,
            uuid: &str,
            entity: Option<NodeInstance>,
        ) -> anyhow::Result<bool>;
        async fn save_changed(&self) -> anyhow::Result<bool>;
    }
    #[async_trait]
    impl IDBRepository<NodeInstance> for NodeInstanceRepository {}
}

// mock! {
//     pub FileMetadataRepository {}
//     #[async_trait]
//     impl IReadOnlyRepository<FileMetadata> for FileMetadataRepository {
//         async fn get_by_id(&self, uuid: &str) -> anyhow::Result<FileMetadata>;
//         async fn get_all(&self) -> anyhow::Result<Vec<FileMetadata>>;
//     }
//     #[async_trait]
//     impl IMutableRepository<FileMetadata> for FileMetadataRepository {
//         async fn update(&self, entity: FileMetadata) -> anyhow::Result<FileMetadata>;
//         async fn insert(&self, entity: FileMetadata) -> anyhow::Result<FileMetadata>;
//         async fn delete(&self, entity: FileMetadata) -> anyhow::Result<bool>;
//         async fn delete_by_id(
//             &self,
//             uuid: &str,
//             entity: Option<FileMetadata>,
//         ) -> anyhow::Result<bool>;
//         async fn save_changed(&self) -> anyhow::Result<bool>;
//     }
//     #[async_trait]
//     impl IDBRepository<FileMetadata> for FileMetadataRepository {}
// }

mock! {
    pub TextStorageRepository{}
    #[async_trait]
    impl IReadOnlyRepository<TextStorage> for TextStorageRepository {
        async fn get_by_id(&self, uuid: &str) -> anyhow::Result<TextStorage>;
        async fn get_all(&self) -> anyhow::Result<Vec<TextStorage>>;
    }
    #[async_trait]
    impl IMutableRepository<TextStorage> for TextStorageRepository {
        async fn update(&self, entity: TextStorage) -> anyhow::Result<TextStorage>;
        async fn insert(&self, entity: TextStorage) -> anyhow::Result<TextStorage>;
        async fn delete(&self, entity: TextStorage) -> anyhow::Result<bool>;
        async fn delete_by_id(
            &self,
            uuid: &str,
            entity: Option<TextStorage>,
        ) -> anyhow::Result<bool>;
        async fn save_changed(&self) -> anyhow::Result<bool>;
    }
    #[async_trait]
    impl IDBRepository<TextStorage> for TextStorageRepository {}
    #[async_trait]
    impl ITextStorageRepository for TextStorageRepository {
        async fn text_already_uuid(&self, text: &str) -> anyhow::Result<Option<Uuid>>;
        async fn get_by_ids(&self, ids: &[Uuid]) -> anyhow::Result<Vec<(Uuid, String)>>;
    }
}

mock! {
    pub SoftwareBlockListRepository{}
    #[async_trait]
    impl ISoftwareBlockListRepository for SoftwareBlockListRepository{
        async fn is_software_version_blocked(
            &self,
            software_name: &str,
            version: &str,
        ) -> anyhow::Result<bool>;
    }
}

mock! {
    pub InstalledSoftwareRepository{}
    #[async_trait]
    impl IInstalledSoftwareRepository for InstalledSoftwareRepository{
        async fn is_software_satisfied(
            &self,
            software_name: &str,
            required_install_arguments: &[String],
        ) -> anyhow::Result<bool>;
    }
}

mock! {
    pub ClusterRepository{}
    #[async_trait]
    impl IClusterRepository for ClusterRepository{
        async fn get_random_cluster(&self) -> anyhow::Result<Uuid>;
    }
    #[async_trait]
    impl IReadOnlyRepository<Cluster> for ClusterRepository {
        async fn get_by_id(&self, uuid: &str) -> anyhow::Result<Cluster>;
        async fn get_all(&self) -> anyhow::Result<Vec<Cluster>>;
    }
}
