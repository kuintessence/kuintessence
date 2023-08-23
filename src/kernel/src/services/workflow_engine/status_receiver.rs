use crate::prelude::*;
use alice_architecture::IMessageQueueProducerTemplate;
use std::sync::Arc;

#[derive(Builder)]
pub struct WorkflowStatusReceiverService {
    node_instance_repository: Arc<dyn INodeInstanceRepository + Send + Sync>,
    workflow_instance_repository: Arc<dyn IWorkflowInstanceRepository + Send + Sync>,
    schedule_service: Arc<dyn IWorkflowScheduleService + Send + Sync>,
    mq_producer: Arc<dyn IMessageQueueProducerTemplate<NodeInstanceId> + Send + Sync>,
    bill_topic: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeInstanceId {
    pub node_instance_id: Uuid,
}

#[async_trait]
impl IWorkflowStatusReceiverService for WorkflowStatusReceiverService {
    async fn receive_node_status(&self, result: TaskResult) -> anyhow::Result<()> {
        let mut node_instance =
            self.node_instance_repository.get_by_id(&result.id.to_string()).await?;
        node_instance.log = Some(result.message);
        node_instance.resource_meter = result.used_resources;
        node_instance.status = match result.status {
            TaskResultStatus::Success => NodeInstanceStatus::Finished,
            TaskResultStatus::Continued => NodeInstanceStatus::Running,
            TaskResultStatus::Paused => NodeInstanceStatus::Paused,
            TaskResultStatus::Failed => NodeInstanceStatus::Error,
            TaskResultStatus::Deleted => NodeInstanceStatus::Stopped,
        };
        self.node_instance_repository.update(node_instance.to_owned()).await?;
        self.node_instance_repository.save_changed().await?;

        if let TaskResultStatus::Success = result.status {
            self.schedule_service
                .schedule_next_nodes(ScheduleMode::NodeInstanceId(result.id))
                .await?;
            self.mq_producer
                .send_object(
                    &NodeInstanceId {
                        node_instance_id: result.id,
                    },
                    Some(&self.bill_topic),
                )
                .await?;
        } else if let TaskResultStatus::Failed = result.status {
            let mut workflow_instance = self
                .workflow_instance_repository
                .get_by_id(&node_instance.flow_instance_id.to_string())
                .await?;
            workflow_instance.status = WorkflowInstanceStatus::Error;
            self.workflow_instance_repository.update(workflow_instance).await?;
        } else if let TaskResultStatus::Paused = result.status {
            let mut workflow_instance = self
                .workflow_instance_repository
                .get_by_id(&node_instance.flow_instance_id.to_string())
                .await?;
            if self
                .node_instance_repository
                .get_all_workflow_instance_nodes(workflow_instance.id)
                .await?
                .iter()
                .filter(|el| matches!(el.status, NodeInstanceStatus::Pausing))
                .count()
                == 0
            {
                workflow_instance.status = WorkflowInstanceStatus::Paused;
                self.workflow_instance_repository.update(workflow_instance).await?;
            }
        } else if let TaskResultStatus::Deleted = result.status {
            let mut workflow_instance = self
                .workflow_instance_repository
                .get_by_id(&node_instance.flow_instance_id.to_string())
                .await?;
            if self
                .node_instance_repository
                .get_all_workflow_instance_nodes(workflow_instance.id)
                .await?
                .iter()
                .filter(|el| matches!(el.status, NodeInstanceStatus::Stopping))
                .count()
                == 0
            {
                workflow_instance.status = WorkflowInstanceStatus::Stopped;
                self.workflow_instance_repository.update(workflow_instance).await?;
            }
        }

        self.workflow_instance_repository.save_changed().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mock::prelude::*;

    async fn load() -> Arc<WorkflowStatusReceiverService> {
        let json_repository =
            JSONRepository::new("C:\\Users\\Zooey\\JsonRepository").await.unwrap();
        let json_repository = Arc::new(json_repository);
        let mut file_move_service = MockFileMoveService::new();
        let mut storage_server_download_dispatcher_service =
            MockStorageServerDownloadDispatcherService::new();
        storage_server_download_dispatcher_service
            .expect_get_text()
            .returning(|_| Ok("4".to_string()));
        let storage_server_download_dispatcher_service =
            Arc::new(storage_server_download_dispatcher_service);
        file_move_service.expect_register_move().returning(|_| Ok(()));
        file_move_service.expect_do_registered_moves().returning(|_| Ok(()));
        let file_move_service = Arc::new(file_move_service);

        let mut usecase_select_service = MockUsecaseSelectService::new();
        usecase_select_service.expect_send_usecase().returning(|_| Ok(()));
        let usecase_select_service = Arc::new(usecase_select_service);

        let mut text_storage_repository = MockTextStorageRepository::new();
        text_storage_repository.expect_get_by_id().returning(|_| {
            Ok(TextStorage {
                key: Some(Uuid::parse_str("0ec4e324-0d51-434e-baf5-36424a8e75f5").unwrap()),
                value: "5".to_string(),
            })
        });
        text_storage_repository.expect_insert().returning(Ok);
        text_storage_repository.expect_save_changed().returning(|| Ok(true));
        let text_storage_repository = Arc::new(text_storage_repository);

        let schedule_service = Arc::new(
            WorkflowScheduleServiceBuilder::default()
                .text_storage_repository(text_storage_repository)
                .node_instance_repository(json_repository.clone())
                .workflow_instance_repository(json_repository.clone())
                .file_move_service(file_move_service)
                .usecase_select_service(usecase_select_service)
                .download_service(storage_server_download_dispatcher_service)
                .build()
                .unwrap(),
        );
        Arc::new(
            WorkflowStatusReceiverServiceBuilder::default()
                .node_instance_repository(json_repository.clone())
                .workflow_instance_repository(json_repository)
                .schedule_service(schedule_service)
                .build()
                .unwrap(),
        )
    }

    #[tokio::test]
    pub async fn test_success() {
        let status_receiver = load().await;

        let success_id = status_receiver
            .node_instance_repository
            .get_all()
            .await
            .unwrap()
            .iter()
            .filter(|el| el.status.eq(&NodeInstanceStatus::Running))
            .last()
            .unwrap()
            .id
            .to_owned();

        status_receiver
            .receive_node_status(TaskResult {
                id: success_id,
                status: TaskResultStatus::Success,
                message: "no".to_string(),
                used_resources: None,
            })
            .await
            .unwrap()
    }
}
