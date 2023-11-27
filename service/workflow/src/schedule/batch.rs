use std::{collections::HashMap, sync::Arc};

use alice_architecture::repository::DBRepository;
use chrono::Utc;
use domain_storage::{
    model::{
        entity::{move_registration::MoveDestination, MoveRegistration, TextStorage},
        vo::HashAlgorithm,
    },
    service::{FileMoveService, StorageServerDownloadDispatcherService},
};
use domain_workflow::{
    model::{
        entity::{
            workflow_instance::{NodeSpec, NodeSpecOutputSlotKind},
            WorkflowInstance,
        },
        vo::{
            BatchStrategy, BatchStrategyKind, FileInput, Input, NodeInputSlot, NodeInputSlotKind,
            NodeRelation, SchedulingStrategy,
        },
    },
    repository::{NodeInstanceRepo, WorkflowInstanceRepo},
};
use uuid::Uuid;

pub struct BatchService {
    node_instance_repository: Arc<dyn NodeInstanceRepo>,
    workflow_instance_repository: Arc<dyn WorkflowInstanceRepo>,
    file_move_service: Arc<dyn FileMoveService>,
    download_service: Arc<dyn StorageServerDownloadDispatcherService>,
    text_storage_repository: Arc<dyn DBRepository<TextStorage>>,
}

impl BatchService {
    pub async fn get_task_node_specs(
        &self,
        flow: WorkflowInstance,
        entry_nodes_ids: Vec<Uuid>,
    ) -> anyhow::Result<Vec<NodeSpec>> {
        let mut entry_nodes = flow
            .spec
            .node_specs
            .iter()
            .filter(|n| entry_nodes_ids.contains(&n.id))
            .cloned()
            .collect::<Vec<_>>();
        let flow_schedule_strategy = &flow.spec.scheduling_strategy;
        let mut task_node_specs = vec![];

        // Iterate the entry node list
        for entry_node in entry_nodes.iter_mut() {
            if let SchedulingStrategy::Auto = entry_node.scheduling_strategy {
                entry_node.scheduling_strategy = flow_schedule_strategy.to_owned();
            }
            // Get this entry node's relations.
            let node_relations = flow.node_dependency_relations(entry_node.id);
            // Is batch node.
            if entry_node.batch_strategies.is_empty() {
                // Is rely on other node
                if node_relations.is_empty() {
                    task_node_specs.push(entry_node.to_owned());
                } else {
                    for node_relation in node_relations.iter() {
                        // For each rely input slot
                        for slot_relation in node_relation.slot_relations.iter() {
                            // Find relied node.
                            let from_node = flow.spec.node(node_relation.from_id);
                            // Get input slot mut ref.
                            let to_slot = entry_node.mut_input_slot(&slot_relation.to_slot);
                            // Get relied slot.
                            let from_slot = from_node.output_slot(&slot_relation.from_slot);
                            match &mut to_slot.kind {
                                NodeInputSlotKind::Text { contents, rule: _ } => {
                                    *contents = Some(vec![
                                        from_slot
                                            .all_tasks_text_outputs()?
                                            .get(0)
                                            .unwrap()
                                            .to_owned();
                                        1
                                    ]);
                                }
                                NodeInputSlotKind::File { contents, .. } => {
                                    *contents = Some(vec![
                                        FileInput {
                                            file_metadata_id: from_slot
                                                .all_tasks_file_outputs()?
                                                .get(0)
                                                .unwrap()
                                                .to_owned(),
                                            ..Default::default()
                                        };
                                        1
                                    ]);
                                }
                                NodeInputSlotKind::Unknown => {
                                    anyhow::bail!("unreachable InputSlotKind")
                                }
                            }
                        }
                    }
                    task_node_specs.push(entry_node.to_owned());
                }
            } else {
                task_node_specs.push(entry_node.to_owned());
                let batch_nodes = self.debatch(&node_relations, entry_node).await?;
                let entry_node_output_slots = &mut entry_node.output_slots;
                for (i, task_node) in batch_nodes.iter().enumerate() {
                    for entry_node_output_slot in entry_node_output_slots.iter_mut() {
                        let task_node_output_slot =
                            task_node.output_slot(&entry_node_output_slot.descriptor);
                        match &mut entry_node_output_slot.kind {
                            NodeSpecOutputSlotKind::File {
                                all_tasks_prepared_content_ids,
                                ..
                            } => {
                                if i == 0 {
                                    all_tasks_prepared_content_ids.clear();
                                }
                                all_tasks_prepared_content_ids.push(
                                    task_node_output_slot
                                        .all_tasks_file_outputs()?
                                        .get(0)
                                        .unwrap()
                                        .to_owned(),
                                )
                            }
                            NodeSpecOutputSlotKind::Text {
                                all_tasks_prepared_text_keys,
                                ..
                            } => {
                                if i == 0 {
                                    all_tasks_prepared_text_keys.clear();
                                }
                                all_tasks_prepared_text_keys.push(
                                    task_node_output_slot
                                        .all_tasks_text_outputs()?
                                        .get(0)
                                        .unwrap()
                                        .to_owned(),
                                )
                            }
                        }
                    }
                    task_node_specs.push(task_node.to_owned());
                }
            }
        }
        Ok(task_node_specs)
    }
    /// 传入节点 id 集合、节点依赖关系 id 集合，获得一批入口节点 id
    pub async fn find_entry_nodes_ids(
        node_ids: &[Uuid],
        node_dependencies: &Vec<(Uuid, Uuid)>,
    ) -> Vec<Uuid> {
        let mut entry_nodes = vec![];
        // 查找入口节点
        let mut adjacency_map = HashMap::<Uuid, i32>::new();
        // println!("\n\n");
        // println!("node_ids: \n{node_ids:#?}");
        // println!("node_dependencies: \n{node_dependencies:#?}");
        for node_id in node_ids {
            adjacency_map.insert(*node_id, 0);
        }
        for (_from_id, to_id) in node_dependencies {
            adjacency_map.insert(*to_id, adjacency_map.get(to_id).unwrap_or(&0) + 1);
        }
        // println!("adjacency_map: \n{adjacency_map:#?}");
        for (node_id, adjacency) in adjacency_map {
            if 0.eq(&adjacency) {
                entry_nodes.push(node_id.to_owned())
            }
        }
        // println!("entry_nodes: \n{entry_nodes:#?}");
        // println!("\n\n");
        entry_nodes
    }

    async fn debatch(
        &self,
        node_relations: &[NodeRelation],
        node_spec: &NodeSpec,
    ) -> anyhow::Result<Vec<NodeSpec>> {
        // 该节点各个插槽的批量输入可能性（暂时不考虑多个文件对应于同一次批量作业的情况）
        let mut all_slot_all_possible_inputs: Vec<(&str, Vec<Input>)> = vec![];
        // 遍历批量策略
        // 又因为每个批量策略只对应于一个输入插槽
        // 所以每次遍历批量策略，为一个批量输入插槽解析出所有可能的输入
        for batch_strategy in node_spec.batch_strategies.iter() {
            let descriptor = &batch_strategy.input_slot_descriptor;
            // 获取批量策略对应的插槽
            let input_slot = node_spec.input_slot(descriptor);
            // 为一个批量输入插槽解析出所有可能的输入 Vec<Input>，一个 Input 对应一个子任务的输入
            let batch_inputs =
                self.get_batch_inputs(node_relations, batch_strategy, input_slot).await?;
            // 创建输入插槽与可能性输入关系的元组向量
            all_slot_all_possible_inputs.push((descriptor, batch_inputs));
        }
        let sub_nodes = self.sub_nodes(node_spec, &all_slot_all_possible_inputs).await?;
        Ok(sub_nodes)
    }

    /// 根据节点 spec 以及其所有批量插槽及其所有可能性输入，解析出该节点实例对应的批量子节点
    /// 并且用到了节点实例仓储，根据批量父节点 id 获取其所有在 node_instance 表中存储的子节点信息（id），从而保证解析出来的节点都能够对应上数据库中的子节点信息
    /// 返回所有批量子节点信息
    /// （√）
    async fn sub_nodes(
        &self,
        node_spec: &NodeSpec,
        // 输入插槽描述符与其所有可能输入对应的元组数组
        slot_descriptor_inputs: &[(&str, Vec<Input>)],
    ) -> anyhow::Result<Vec<NodeSpec>> {
        // 初始化所有插槽的所有可能性的输入
        let mut all_slot_all_possible_inputs: Vec<Vec<(&str, Input)>> = vec![];
        // 计算出所有插槽的所有可能性的输入
        for (slot_descriptor, i) in slot_descriptor_inputs.iter() {
            if all_slot_all_possible_inputs.is_empty() {
                for j in i {
                    all_slot_all_possible_inputs.push(vec![(slot_descriptor, j.to_owned())]);
                }
            } else {
                let temp = all_slot_all_possible_inputs.clone();
                all_slot_all_possible_inputs.clear();
                for j in i {
                    for k in &temp {
                        let mut temp = k.clone();
                        temp.push((slot_descriptor, j.to_owned()));
                        all_slot_all_possible_inputs.push(temp);
                    }
                }
            }
        }

        let x = self.node_instance_repository.get_node_sub_node_instances(node_spec.id).await?;
        // 获取所有批量子节点的 id
        let sub_nodes_ids: Vec<_> = x.iter().map(|el| el.id).collect();
        let tasks_inputs = sub_nodes_ids
            .into_iter()
            .zip(all_slot_all_possible_inputs.iter())
            .collect::<Vec<_>>();
        node_spec.parse_sub_nodes(&tasks_inputs)
    }

    /// 获取单个批量策略对应的输入插槽所有可能的输入
    /// （√）
    async fn get_batch_inputs(
        &self,
        node_relations: &[NodeRelation],
        batch_strategy: &BatchStrategy,
        input_slot: &NodeInputSlot,
    ) -> anyhow::Result<Vec<Input>> {
        let renaming_pattern = batch_strategy.renaming_pattern.clone();
        let input_slot_descriptor = batch_strategy.input_slot_descriptor.clone();
        match &batch_strategy.kind {
            // 如果是 OriginalBatch 类型的批量，直接一批输入对应一个批量子任务
            BatchStrategyKind::OriginalBatch => {
                let mut result = input_slot.inputs();
                // OriginalBatch 类型的批量，
                // 如果输入类型是文件，需要附加 rename
                // 如果是文本类型的输入，不需要做任何操作
                match input_slot.kind {
                    NodeInputSlotKind::File { .. } => result
                        .iter_mut()
                        .map(|el| match el {
                            Input::File(file_input) => {
                                file_input.file_metadata_name = renaming_pattern
                                    .as_ref()
                                    .unwrap()
                                    .replace("{}", &Uuid::new_v4().to_string().replace('-', ""))
                            }
                            _ => unreachable!(),
                        })
                        .collect(),
                    _ => unreachable!(),
                }
                Ok(result)
            }
            BatchStrategyKind::MatchRegex {
                regex_to_match,
                fill_count,
                filler,
                ..
            } => match &input_slot.kind {
                NodeInputSlotKind::Text { contents, .. } => {
                    // 因为 MatchRegex 类型的批量输入只会有一个
                    let content = contents.as_ref().unwrap().iter().next().unwrap();
                    let content = self.text_storage_repository.get_by_id(*content).await?.value;
                    let texts = filler.fill_match_regex(&content, regex_to_match, *fill_count);
                    let mut result = vec![];
                    // 文字存储中插入数据，并将键存储到 Input 中
                    for text in texts.iter() {
                        let key = Uuid::new_v4();
                        self.text_storage_repository
                            .insert(&TextStorage {
                                key: Some(key),
                                value: text.to_string(),
                            })
                            .await?;
                        result.push(Input::Text(key))
                    }
                    self.text_storage_repository.save_changed().await?;
                    Ok(result)
                }
                NodeInputSlotKind::File { contents, .. } => {
                    // 因为 MatchRegex 类型的批量输入只会有一个
                    let content = contents.as_ref().unwrap().get(0).unwrap();
                    // 获取文件的文本内容
                    let content = self.download_service.get_text(content.file_metadata_id).await?;
                    let contents = filler.fill_match_regex(&content, regex_to_match, *fill_count);
                    let file_names = vec![renaming_pattern.as_ref().unwrap(); *fill_count];
                    // generated_files：新文件名 zip 上内容
                    let generated_files: Vec<_> = file_names
                        .iter()
                        .map(|el| el.replace("{}", Utc::now().timestamp().to_string().as_str()))
                        .zip(contents)
                        .collect();
                    let mut result = Vec::with_capacity(*fill_count);
                    // 将新生成的文件上传到文件存储服务
                    for (file_name, content) in generated_files.iter() {
                        let size = content.as_bytes().len();
                        let file_metadata_id = Uuid::new_v4();
                        let hash = blake3::hash(content.as_bytes()).to_string();

                        self.file_move_service
                            .register_move(MoveRegistration {
                                id: Uuid::new_v4(),
                                meta_id: file_metadata_id,
                                file_name: file_name.to_owned(),
                                hash: hash.to_owned(),
                                hash_algorithm: HashAlgorithm::Blake3,
                                size: size as u64,
                                destination: MoveDestination::StorageServer {
                                    record_net_disk: None,
                                },
                                is_upload_failed: false,
                                failed_reason: None,
                            })
                            .await?;
                        self.file_move_service.do_registered_moves(file_metadata_id).await?;

                        result.push(Input::File(FileInput {
                            file_metadata_id,
                            file_metadata_name: file_name.to_owned(),
                            hash,
                            size,
                        }));
                    }
                    Ok(result)
                }
                NodeInputSlotKind::Unknown => unreachable!(),
            },
            // 从批量节点的输出插槽获取的输入
            BatchStrategyKind::FromBatchOutputs => {
                let mut result = vec![];
                let mut in_node_id: Option<_> = Option::None;
                let mut from_slot_descriptor: Option<_> = Option::None;
                for node_relation in node_relations.iter() {
                    for slot_relation in node_relation.slot_relations.iter() {
                        if slot_relation.to_slot.eq(&input_slot_descriptor) {
                            in_node_id = Some(node_relation.from_id.to_owned());
                            from_slot_descriptor = Some(slot_relation.from_slot.to_owned());
                        }
                    }
                }
                let in_node_id = in_node_id.unwrap();
                let from_slot_descriptor = from_slot_descriptor.unwrap();
                let workflow_instance =
                    self.workflow_instance_repository.get_by_node_id(in_node_id).await?;
                let in_node_spec = workflow_instance.spec.node(in_node_id);
                let output_slot = in_node_spec.output_slot(&from_slot_descriptor);
                match &output_slot.kind {
                    NodeSpecOutputSlotKind::File {
                        all_tasks_prepared_content_ids,
                        ..
                    } => {
                        for tasks_prepared_content_id in all_tasks_prepared_content_ids.iter() {
                            result.push(Input::File(FileInput {
                                file_metadata_id: tasks_prepared_content_id.to_owned(),
                                file_metadata_name: String::default(),
                                hash: String::default(),
                                size: usize::default(),
                            }))
                        }
                    }
                    NodeSpecOutputSlotKind::Text {
                        all_tasks_prepared_text_keys,
                        ..
                    } => {
                        for task_prepared_text_key in all_tasks_prepared_text_keys.iter() {
                            result.push(Input::Text(task_prepared_text_key.to_owned()))
                        }
                    }
                }
                Ok(result)
            }
        }
    }
}
