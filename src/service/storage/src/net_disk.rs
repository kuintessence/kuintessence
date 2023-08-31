use std::sync::Arc;

use alice_architecture::utils::Anyhow;
use alice_architecture::IReadOnlyRepository;
use async_trait::async_trait;
use chrono::Utc;
use domain_storage::{
    command::CreateNetDiskFileCommand,
    model::entity::net_disk::{FileType, NetDisk, NetDiskMeta, RecordNetDiskKind},
    repository::NetDiskRepo,
    service::*,
};
use domain_workflow::model::entity::{NodeInstance, WorkflowInstance};
use typed_builder::TypedBuilder;
use uuid::Uuid;

#[derive(TypedBuilder)]
pub struct NetDiskServiceImpl {
    net_disk_repo: Arc<dyn NetDiskRepo>,
    node_instance_repo: Arc<dyn IReadOnlyRepository<NodeInstance> + Send + Sync>,
    flow_instance_repo: Arc<dyn IReadOnlyRepository<WorkflowInstance> + Send + Sync>,
}

#[async_trait]
impl NetDiskService for NetDiskServiceImpl {
    async fn create_file(&self, command: CreateNetDiskFileCommand) -> Anyhow {
        use RecordNetDiskKind::*;
        let (meta_id, file_name, file_kind) =
            (command.meta_id, command.file_name, command.file_type);
        match command.kind {
            NodeInstance { node_id } => {
                self.create_node_instance_file(node_id, meta_id, &file_name, &file_kind).await?;
            }
            FlowDraft { .. } => {
                self.get_or_create_user_root_id(None).await?;
                // 不再创建网盘草稿文件夹
                // self.create_flow_draft_file(flow_draft_id, meta_id, &file_name, &file_kind)
                //     .await?;
            }
            Normal { parent_id } => {
                self.create_normal_file(parent_id, meta_id, &file_name, &file_kind).await?;
            }
        }
        Ok(())
    }
}

impl NetDiskServiceImpl {
    async fn get_or_create_user_root_id(&self, user_id: Option<Uuid>) -> Anyhow<Uuid> {
        let user_root = self.net_disk_repo.get_root_id(user_id).await?;
        Ok(match user_root {
            Some(el) => el,
            None => {
                let id = self.net_disk_repo.create_root().await?;
                self.net_disk_repo.save_changed().await?;
                id
            }
        })
    }
    async fn create_node_instance_file(
        &self,
        node_id: Uuid,
        meta_id: Uuid,
        file_name: &str,
        file_kind: &FileType,
    ) -> Anyhow {
        let node_instance = self.node_instance_repo.get_by_id(&node_id.to_string()).await?;
        let flow_instance_id = node_instance.flow_instance_id;
        let node_name = node_instance.name;
        let flow_instance =
            self.flow_instance_repo.get_by_id(&flow_instance_id.to_string()).await?;
        let flow_name = flow_instance.name;
        let user_id = Some(flow_instance.user_id);
        let node_instance_dir_id = self
            .get_or_create_node_instance_dir_id(
                node_id,
                flow_instance_id,
                &node_name,
                &flow_name,
                user_id,
            )
            .await?;
        let name = self.fix_file_name(Some(node_instance_dir_id), file_name, user_id).await?;

        self.net_disk_repo
            .insert(NetDisk {
                id: Uuid::new_v4(),
                parent_id: Some(node_instance_dir_id),
                name,
                is_dict: false,
                kind: file_kind.to_owned(),
                file_metadata_id: Some(meta_id),
                meta: Some(NetDiskMeta {
                    flow_instance_id: Some(flow_instance_id),
                    node_instance_id: Some(node_id),
                    ..Default::default()
                }),
                user_id,
            })
            .await?;

        self.net_disk_repo.save_changed().await?;
        Ok(())
    }

    // async fn create_flow_draft_file(
    //     &self,
    //     flow_draft_id: Uuid,
    //     meta_id: Uuid,
    //     file_name: &str,
    //     file_kind: &FileType,
    // ) -> Anyhow {
    //     let flow_name = self.flow_draft_repo.get_by_id(&flow_draft_id.to_string()).await?.name;
    //     let parent_id = self.get_or_create_flow_draft_dir_id(flow_draft_id, &flow_name).await?;

    //     let name = self.fix_file_name(Some(parent_id), file_name, None).await?;

    //     self.net_disk_repo
    //         .insert(NetDisk {
    //             id: Uuid::new_v4(),
    //             parent_id: Some(parent_id),
    //             name,
    //             is_dict: false,
    //             kind: file_kind.to_owned(),
    //             file_metadata_id: Some(meta_id),
    //             meta: Some(NetDiskMeta {
    //                 flow_draft_id: Some(flow_draft_id),
    //                 ..Default::default()
    //             }),
    //             user_id: None,
    //         })
    //         .await?;
    //     self.net_disk_repo.save_changed().await?;
    //     Ok(())
    // }

    async fn create_normal_file(
        &self,
        mut parent_id: Option<Uuid>,
        meta_id: Uuid,
        file_name: &str,
        file_kind: &FileType,
    ) -> Anyhow {
        let name = self.fix_file_name(parent_id, file_name, None).await?;
        parent_id = parent_id.or(Some(self.get_or_create_user_root_id(None).await?));

        self.net_disk_repo
            .insert(NetDisk {
                id: Uuid::new_v4(),
                parent_id,
                name,
                is_dict: false,
                kind: file_kind.to_owned(),
                file_metadata_id: Some(meta_id),
                meta: None,
                user_id: None,
            })
            .await?;

        self.net_disk_repo.save_changed().await?;
        Ok(())
    }

    /// When create a record where there already is one with the same name, parent_id, and owner_id.
    ///
    /// Change its name before insert.
    async fn fix_file_name(
        &self,
        parent_id: Option<Uuid>,
        file_name: &str,
        user_id: Option<Uuid>,
    ) -> Anyhow<String> {
        let new_file_name = match self
            .net_disk_repo
            .is_same_pid_fname_exists(parent_id, file_name, user_id)
            .await?
        {
            true => {
                let suffix = Utc::now().format("%Y%m%d%H%M%S%3f");
                format!("{file_name}_{suffix}")
            }
            false => file_name.to_owned(),
        };
        Ok(new_file_name)
    }

    // /// Get or create the flow draft file's parent dir.
    // async fn get_or_create_flow_draft_dir_id(
    //     &self,
    //     flow_draft_id: Uuid,
    //     flow_name: &str,
    // ) -> Anyhow<Uuid> {
    //     if let Some(el) = self.net_disk_repo.get_flow_draft_dir_id(flow_draft_id).await? {
    //         return Ok(el);
    //     };

    //     let flow_draft_root_dir_id = match self.net_disk_repo.get_flow_draft_root_id().await? {
    //         Some(el) => el,
    //         None => {
    //             let root_id = self.get_or_create_user_root_id(None).await?;
    //             let id = self.net_disk_repo.insert(NetDisk::flow_draft_root(root_id)).await?.id;
    //             self.net_disk_repo.save_changed().await?;
    //             id
    //         }
    //     };

    //     let flow_draft_dir_id = self
    //         .net_disk_repo
    //         .insert(NetDisk::flow_draft_dir(
    //             flow_draft_root_dir_id,
    //             flow_draft_id,
    //             flow_name,
    //         ))
    //         .await?
    //         .id;
    //     self.net_disk_repo.save_changed().await?;
    //     Ok(flow_draft_dir_id)
    // }

    async fn get_or_create_flow_instance_dir(
        &self,
        flow_instance_id: Uuid,
        flow_name: &str,
        user_id: Option<Uuid>,
    ) -> Anyhow<Uuid> {
        if let Some(el) = self.net_disk_repo.get_flow_instance_dir_id(flow_instance_id).await? {
            return Ok(el);
        };

        let flow_instance_root_dir_id =
            match self.net_disk_repo.get_flow_instance_root_id(user_id).await? {
                Some(el) => el,
                None => {
                    let root_id = self.get_or_create_user_root_id(user_id).await?;
                    let id = self
                        .net_disk_repo
                        .insert(NetDisk::flow_instance_root(root_id, user_id))
                        .await?
                        .id;
                    self.net_disk_repo.save_changed().await?;
                    id
                }
            };

        let flow_instance_dir_id = self
            .net_disk_repo
            .insert(NetDisk::flow_instance_dir(
                flow_instance_root_dir_id,
                flow_instance_id,
                flow_name,
                user_id,
            ))
            .await?
            .id;
        self.net_disk_repo.save_changed().await?;
        Ok(flow_instance_dir_id)
    }

    async fn get_or_create_node_instance_dir_id(
        &self,
        node_id: Uuid,
        flow_instance_id: Uuid,
        node_name: &str,
        flow_name: &str,
        user_id: Option<Uuid>,
    ) -> Anyhow<Uuid> {
        if let Some(el) = self.net_disk_repo.get_node_instance_dir_id(node_id).await? {
            return Ok(el);
        };

        let flow_instance_dir_id = self
            .get_or_create_flow_instance_dir(flow_instance_id, flow_name, user_id)
            .await?;
        let node_instance_dir_id = self
            .net_disk_repo
            .insert(NetDisk::node_instance_dir(
                flow_instance_dir_id,
                flow_instance_id,
                node_id,
                node_name,
                user_id,
            ))
            .await?
            .id;
        self.net_disk_repo.save_changed().await?;
        Ok(node_instance_dir_id)
    }
}
