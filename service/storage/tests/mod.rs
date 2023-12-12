use domain_storage::{
    mock::{MockMoveRegistrationRepo, MockSnapshotRepo},
    model::{entity::MoveRegistration, vo::HashAlgorithm},
};

use domain_workflow::mock::{MockNodeInstanceRepo, MockQueueRepo, MockWorkflowInstanceRepo};
use service_storage::FileMoveServiceImpl;

#[tokio::test]
async fn test_multipart_upload_from_net_disk() {
    let shard_size = 512;
    let test = include_bytes!("test_text");

    let file_name = "test_text";
    let hash = blake3::hash(test).to_string();
    let hahs_algorithm = HashAlgorithm::Blake3;
    let size = 4001;
    let count = 4001 / 512 + 1;

    // let parent_id = None;
    // let meta_id = None;
    let mut move_repo = MockMoveRegistrationRepo::new();
    let mut snapshot_repo = MockSnapshotRepo::new();
    let mut node_instance_repo = MockNodeInstanceRepo::new();
    let mut workflow_instance_repo = MockWorkflowInstanceRepo::new();
    let mut queue_repo = MockQueueRepo::new();

    // // let move_service = FileMoveServiceImpl::builder()
    // let repos = MockRepos::new().expect_get_by_id().return_once(|_| {
    //     Ok(MoveRegistration {
    //         id: todo!(),
    //         meta_id: todo!(),
    //         file_name: todo!(),
    //         hash,
    //         hash_algorithm: HashAlgorithm::Blake3,
    //         size: todo!(),
    //         destination: todo!(),
    //         is_upload_failed: todo!(),
    //         failed_reason: todo!(),
    //     })
    // });
}
