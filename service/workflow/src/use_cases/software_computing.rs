use alice_architecture::{
    message_queue::producer::MessageQueueProducerTemplate, repository::DbField,
};

use async_trait::async_trait;
use domain_content_repo::{
    model::vo::abilities::{
        common::FileKind,
        software_computing::{
            software::{
                materials::inputs::{Argument, Environment},
                SoftwareSpec as RepoSoftwareSpec,
            },
            usecase::{
                collected_out::{
                    CollectFrom as RepoCollectFrom, CollectRule as RepoCollectRule,
                    CollectTo as RepoCollectTo,
                },
                spec::*,
            },
        },
    },
    service::CoSoftwareComputingUsecaseService,
};
use domain_storage::repository::TextStorageRepo;
use domain_workflow::{
    model::{
        entity::{
            self,
            node_instance::{DbNodeInstance, NodeInstanceKind},
            workflow_instance::NodeSpec,
        },
        vo::{
            msg::{ChangeMsg, Info, TaskChangeInfo, TaskStatusChange},
            task_dto::{
                CollectFrom, CollectOutput, CollectRule, CollectTo, DeploySoftware, DownloadFile,
                ExecuteUsecase, FacilityKind, FileTransmitKind, StartTaskBody, StdInKind,
                UploadFile,
            },
            NodeInputSlotKind, NodeKind,
        },
    },
    repository::*,
    service::{QueueResourceService, UsecaseParseService},
};
use handlebars::Handlebars;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use typed_builder::TypedBuilder;
use uuid::Uuid;

/// 软件用例解析微服务
#[derive(TypedBuilder)]
pub struct SoftwareComputingUsecaseServiceImpl {
    /// 软件用例获取器
    computing_usecase_repo: Arc<dyn CoSoftwareComputingUsecaseService>,
    /// 文本仓储
    text_storage_repository: Arc<dyn TextStorageRepo>,
    /// 软件黑名单仓储
    software_block_list_repository: Arc<dyn SoftwareBlockListRepo>,
    /// 已安装软件仓储
    installed_software_repository: Arc<dyn InstalledSoftwareRepo>,
    /// 队列资源服务
    queue_resource_service: Arc<dyn QueueResourceService>,
    /// 节点实例仓储
    node_repo: Arc<dyn NodeInstanceRepo>,
    flow_repo: Arc<dyn WorkflowInstanceRepo>,
    task_repo: Arc<dyn TaskRepo>,
    status_mq_producer: Arc<dyn MessageQueueProducerTemplate<ChangeMsg>>,
    status_mq_topic: String,
}

/// 输入内容
#[derive(Clone)]
struct InContent {
    /// 输入作为参数时以空格分隔的字符串
    pub args: String,
    /// 输入文件
    pub infiles: Vec<InFileInfo>,
}

#[derive(Clone)]
pub struct InFileInfo {
    /// 文件路径
    pub path: String,
    /// 是否打包
    pub is_packaged: bool,
    /// 文件id
    pub meta_id: Uuid,
}

/// 格式填充
#[derive(Debug)]
struct FormatFill {
    /// 格式
    pub format: String,
    /// 每个占位符用什么填充
    pub placeholder_fill_map: HashMap<usize, Option<String>>,
}

#[async_trait]
impl UsecaseParseService for SoftwareComputingUsecaseServiceImpl {
    async fn handle_usecase(&self, node_spec: NodeSpec) -> anyhow::Result<()> {
        let queue = self
            .queue_resource_service
            .get_queue(node_spec.id, &node_spec.scheduling_strategy)
            .await?;

        let start_bodys = self.parse_start_bodys(node_spec.to_owned()).await?;
        let mut tasks = vec![];
        for start_body in start_bodys {
            tasks.push(entity::task::Task {
                id: Uuid::new_v4(),
                node_instance_id: node_spec.id,
                r#type: entity::task::TaskType::from_ref(&start_body),
                body: serde_json::to_string(&start_body)?,
                queue_topic: queue.topic_name.to_owned(),
                ..Default::default()
            });
        }

        let tasks2 = tasks.iter().collect::<Vec<_>>();
        self.task_repo.insert_list(&tasks2).await?;
        self.task_repo.save_changed().await?;

        self.node_repo
            .update(&DbNodeInstance {
                id: DbField::Set(node_spec.id),
                queue_id: DbField::Set(Some(queue.id)),
                ..Default::default()
            })
            .await?;
        self.node_repo.save_changed().await?;
        self.status_mq_producer
            .send_object(
                &ChangeMsg {
                    id: node_spec.id,
                    info: Info::Task(TaskChangeInfo {
                        status: TaskStatusChange::Running {
                            is_recovered: false,
                        },
                        ..Default::default()
                    }),
                },
                Some(&self.status_mq_topic),
            )
            .await?;
        Ok(())
    }

    fn get_service_type(&self) -> NodeInstanceKind {
        NodeInstanceKind::SoftwareUsecaseComputing
    }

    async fn get_cmd(&self, node_id: Uuid) -> anyhow::Result<Option<String>> {
        let flow_id = self.node_repo.get_by_id(node_id).await?.flow_instance_id;
        let flow = self.flow_repo.get_by_id(flow_id).await?;
        let node_spec = flow.spec.node(node_id).to_owned();
        let tasks = self.parse_start_bodys(node_spec).await?;
        let name_and_arguments = tasks.iter().find_map(|task| {
            if let StartTaskBody::ExecuteUsecase(ExecuteUsecase {
                name, arguments, ..
            }) = &task
            {
                Some((name, arguments))
            } else {
                None
            }
        });
        Ok(match name_and_arguments {
            Some((name, arguments)) => {
                let arg_str = arguments.join(" ");
                Some(if arg_str.is_empty() {
                    name.to_string()
                } else {
                    format!("{name} {arg_str}")
                })
            }
            None => None,
        })
    }
}

impl SoftwareComputingUsecaseServiceImpl {
    /// 解析节点数据，返回任务
    ///
    /// # 参数
    ///
    /// * `node_spec` - 节点数据
    async fn parse_start_bodys(&self, node_spec: NodeSpec) -> anyhow::Result<Vec<StartTaskBody>> {
        let data = match &node_spec.kind {
            NodeKind::SoftwareUsecaseComputing { data } => data,
            _ => anyhow::bail!("Unreachable node kind!"),
        };

        let (usecase_version_id, software_version_id) = (
            data.usecase_version_id.to_owned(),
            data.software_version_id.to_owned(),
        );

        // 根据用例包 id、软件包 id，获取用例分析数据
        let computing_usecase = self
            .computing_usecase_repo
            .get_computing_usecase(software_version_id, usecase_version_id)
            .await?;

        let usecase_spec = computing_usecase.usecase_spec;
        let argument_materials = computing_usecase.arguments;
        let environment_materials = computing_usecase.environments;
        let filesome_input_materials = computing_usecase.filesome_inputs;
        let filesome_output_materials = computing_usecase.filesome_outputs;
        let software_spec = computing_usecase.software_spec;
        let template_file_infos = computing_usecase.template_file_infos;
        let collected_outs = computing_usecase.collected_outs;
        let requirements = usecase_spec.requirements;
        let override_requirements = node_spec.requirements.to_owned();

        let mut argument_formats_sorts = HashMap::<usize, FormatFill>::new();
        let mut environment_formats_map = HashMap::<String, FormatFill>::new();
        let mut std_in = StdInKind::default();
        let mut tasks = vec![];
        let mut download_files = vec![];
        let mut upload_files = vec![];
        let mut output_collects = vec![];
        let out_descriptor_to_validator = usecase_spec
            .output_slots
            .iter()
            .map(|o| (o.descriptor(), o.validator()))
            .collect::<HashMap<_, _>>();

        // 模板描述符及其键填充值的对应关系集合
        let mut templates_kv_json = HashMap::<String, HashMap<String, Option<String>>>::new();

        for (argument_material_descriptor, sort) in usecase_spec.flag_arguments.iter() {
            let value = Self::argument_format(&argument_materials, argument_material_descriptor);
            argument_formats_sorts.entry(*sort).or_insert(value);
        }

        for environment_material_descriptor in usecase_spec.flag_environments.iter() {
            let (key, value) = Self::environment_kv_format(
                &environment_materials,
                environment_material_descriptor,
            );
            environment_formats_map.entry(key).or_insert(value);
        }

        for input_slot in usecase_spec.input_slots.iter() {
            // 找到该输入插槽的输入
            let in_content = self.get_content(&node_spec, input_slot.descriptor()).await?;

            if let Some(in_content) = in_content.to_owned() {
                let in_files = in_content
                    .infiles
                    .iter()
                    .map(|f| DownloadFile {
                        kind: FileTransmitKind::Center {
                            file_id: f.meta_id,
                            is_packaged: f.is_packaged,
                        },
                        path: f.path.to_owned(),
                    })
                    .collect::<Vec<_>>();
                download_files.extend(in_files);
            }

            match input_slot {
                InputSlot::Text { ref_materials, .. } => {
                    // 处理文本输入的所有挂载
                    for ref_material in ref_materials.iter() {
                        // 判断挂载类型
                        match ref_material {
                            TextRef::ArgRef {
                                descriptor,
                                sort,
                                placeholder_nth,
                            } => {
                                // 获取参数格式
                                let argument_format =
                                    Self::argument_format(&argument_materials, descriptor);

                                argument_formats_sorts
                                    .entry(*sort)
                                    .or_insert(argument_format)
                                    .placeholder_fill_map
                                    .insert(
                                        *placeholder_nth,
                                        in_content.to_owned().map(|el| el.args),
                                    );
                            }

                            TextRef::EnvRef {
                                descriptor,
                                placeholder_nth,
                            } => {
                                let (key, value_format) =
                                    Self::environment_kv_format(&environment_materials, descriptor);

                                environment_formats_map
                                    .entry(key)
                                    .or_insert(value_format)
                                    .placeholder_fill_map
                                    .insert(
                                        *placeholder_nth,
                                        in_content.to_owned().map(|el| el.args),
                                    );
                            }

                            TextRef::StdIn => {
                                std_in = StdInKind::Text {
                                    text: in_content.to_owned().unwrap().args,
                                };
                            }

                            TextRef::TemplateRef {
                                descriptor,
                                ref_keys,
                            } => {
                                for ref_key in ref_keys.iter() {
                                    templates_kv_json
                                        .entry(descriptor.to_owned())
                                        .or_default()
                                        .insert(
                                            ref_key.to_owned(),
                                            in_content.to_owned().map(|el| el.args),
                                        );
                                }
                            }
                        }
                    }
                }

                InputSlot::File { ref_materials, .. } => {
                    for ref_material in ref_materials.iter() {
                        match ref_material {
                            FileRef::ArgRef {
                                descriptor,
                                placeholder_nth,
                                sort,
                            } => {
                                let argument_format =
                                    Self::argument_format(&argument_materials, descriptor);

                                argument_formats_sorts
                                    .entry(*sort)
                                    .or_insert(argument_format)
                                    .placeholder_fill_map
                                    .insert(
                                        *placeholder_nth,
                                        in_content.to_owned().map(|el| el.args),
                                    );
                            }
                            FileRef::EnvRef {
                                descriptor,
                                placeholder_nth,
                            } => {
                                let (key, value_format) =
                                    Self::environment_kv_format(&environment_materials, descriptor);

                                environment_formats_map
                                    .entry(key)
                                    .or_insert(value_format)
                                    .placeholder_fill_map
                                    .insert(
                                        *placeholder_nth,
                                        in_content.to_owned().map(|el| el.args),
                                    );
                            }

                            FileRef::StdIn => {
                                std_in = match in_content.to_owned() {
                                    Some(x) => StdInKind::File { path: x.args },
                                    None => StdInKind::None,
                                };
                            }

                            FileRef::FileInputRef(_) => {
                                // 在 `get_content` 中处理过了，这里不需要再处理
                            }

                            FileRef::TemplateRef {
                                descriptor,
                                ref_keys,
                            } => {
                                for ref_key in ref_keys.iter() {
                                    templates_kv_json
                                        .entry(descriptor.to_owned())
                                        .or_default()
                                        .insert(
                                            ref_key.to_owned(),
                                            in_content.to_owned().map(|el| el.args),
                                        );
                                }
                            }
                        }
                    }
                }
            }
        }

        // 遍历使用的 template
        for (template_descriptor, template_kv_json) in templates_kv_json.iter() {
            let using_template_file = usecase_spec
                .template_files
                .iter()
                .find(|el| el.descriptor.eq(template_descriptor))
                .unwrap();
            let template_file_info = template_file_infos
                .iter()
                .find(|el| el.descriptor.eq(template_descriptor))
                .unwrap();

            let file_name = template_file_info.file_name.to_owned();
            let filled_result =
                Self::get_template_file_result(&template_file_info.content, template_kv_json)?;

            for as_content in using_template_file.as_content.iter() {
                match as_content {
                    TextRef::ArgRef {
                        descriptor,
                        placeholder_nth,
                        sort,
                    } => {
                        let argument_format =
                            Self::argument_format(&argument_materials, descriptor);

                        argument_formats_sorts
                            .entry(*sort)
                            .or_insert(argument_format)
                            .placeholder_fill_map
                            .insert(*placeholder_nth, Some(filled_result.to_owned()));
                    }

                    TextRef::EnvRef {
                        descriptor,
                        placeholder_nth,
                    } => {
                        let (key, value_format) =
                            Self::environment_kv_format(&environment_materials, descriptor);

                        environment_formats_map
                            .entry(key)
                            .or_insert(value_format)
                            .placeholder_fill_map
                            .insert(*placeholder_nth, Some(filled_result.to_owned()));
                    }

                    TextRef::StdIn => {
                        std_in = StdInKind::Text {
                            text: filled_result.to_owned(),
                        };
                    }

                    TextRef::TemplateRef {
                        descriptor: _,
                        ref_keys: _,
                    } => todo!(),
                }
            }

            if !(using_template_file.as_file_name.is_empty()
                || using_template_file.as_file_name.len() == 1
                    && matches!(
                        using_template_file.as_file_name.get(0).unwrap(),
                        FileRef::FileInputRef(_)
                    ))
            {
                download_files.push(DownloadFile {
                    kind: FileTransmitKind::Text {
                        content: filled_result.to_owned(),
                    },
                    path: file_name.to_owned(),
                });
            }

            for as_file_name in using_template_file.as_file_name.iter() {
                match as_file_name {
                    FileRef::ArgRef {
                        descriptor,
                        placeholder_nth,
                        sort,
                    } => {
                        let argument_format =
                            Self::argument_format(&argument_materials, descriptor);

                        argument_formats_sorts
                            .entry(*sort)
                            .or_insert(argument_format)
                            .placeholder_fill_map
                            .insert(*placeholder_nth, Some(file_name.to_owned()));
                    }

                    FileRef::EnvRef {
                        descriptor,
                        placeholder_nth,
                    } => {
                        let (key, value_format) =
                            Self::environment_kv_format(&environment_materials, descriptor);

                        environment_formats_map
                            .entry(key)
                            .or_insert(value_format)
                            .placeholder_fill_map
                            .insert(*placeholder_nth, Some(file_name.to_owned()));
                    }

                    FileRef::StdIn => {
                        std_in = StdInKind::File {
                            path: file_name.to_owned(),
                        }
                    }

                    FileRef::FileInputRef(input_material_descriptor) => {
                        match filesome_input_materials
                            .iter()
                            .find(|el| el.descriptor.eq(input_material_descriptor))
                            .unwrap()
                            .file_kind
                            .to_owned()
                        {
                            FileKind::Normal(wild_card) => download_files.push(DownloadFile {
                                kind: FileTransmitKind::Text {
                                    content: filled_result.to_owned(),
                                },
                                path: wild_card,
                            }),
                            FileKind::Batched(wild_card) => download_files.push(DownloadFile {
                                path: wild_card,
                                kind: FileTransmitKind::Text {
                                    content: filled_result.to_owned(),
                                },
                            }),
                        }
                    }

                    FileRef::TemplateRef {
                        descriptor: _,
                        ref_keys: _,
                    } => todo!(),
                }
            }
        }

        for output_slot in usecase_spec.output_slots.iter() {
            match output_slot {
                OutputSlot::Text {
                    collected_out_descriptor,
                    optional,
                    descriptor,
                    ..
                } => {
                    let collected_out = collected_outs
                        .iter()
                        .find(|el| el.descriptor.eq(collected_out_descriptor))
                        .unwrap();
                    // 解析从哪收集
                    let from = match collected_out.from.to_owned() {
                        RepoCollectFrom::FileOut(fileout_descriptor) => {
                            // 因为文件名有可能被通过输入插槽改写，不能直接使用软件包中定义的输出文件默认名字
                            let mut path = String::default();
                            for out_slot in usecase_spec.output_slots.iter() {
                                if let OutputSlot::File {
                                    descriptor, origin, ..
                                } = out_slot
                                {
                                    if descriptor.eq(&fileout_descriptor) {
                                        match origin {
                                            FileOutOrigin::CollectedOut(_) => todo!(),
                                            FileOutOrigin::UsecaseOut(
                                                file_out_and_appointed_by,
                                            ) => {
                                                let filesome_output = filesome_output_materials
                                                    .iter()
                                                    .find(|el| {
                                                        el.descriptor.eq(&file_out_and_appointed_by
                                                            .file_out_material_descriptor)
                                                    })
                                                    .unwrap();
                                                let out_path_alter =
                                                    match file_out_and_appointed_by.kind.to_owned()
                                                    {
                                                        AppointedBy::Material => None,
                                                        AppointedBy::InputSlot {
                                                            text_input_descriptor,
                                                        } => {
                                                            match node_spec
                                                                .input_slot(&text_input_descriptor)
                                                                .kind
                                                                .to_owned()
                                                            {
                                                                NodeInputSlotKind::Text {
                                                                    contents,
                                                                    ..
                                                                } => Some(
                                                                    self.text_storage_repository
                                                                        .get_by_id(
                                                                            *contents
                                                                                .unwrap()
                                                                                .get(0)
                                                                                .unwrap(),
                                                                        )
                                                                        .await?
                                                                        .value,
                                                                ),
                                                                _ => unreachable!(),
                                                            }
                                                        }
                                                    };
                                                path =
                                                    out_path_alter.unwrap_or(match filesome_output
                                                        .file_kind
                                                        .to_owned()
                                                    {
                                                        FileKind::Normal(path) => path,
                                                        FileKind::Batched(path) => path,
                                                    });
                                                break;
                                            }
                                        }
                                    }
                                }
                            }

                            CollectFrom::FileOut { path }
                        }
                        RepoCollectFrom::Stdout => CollectFrom::Stdout,
                        RepoCollectFrom::Stderr => CollectFrom::Stderr,
                    };
                    // 解析收集到哪里去
                    let to = match collected_out.to.to_owned() {
                        RepoCollectTo::Text => {
                            let id = node_spec
                                .output_slots
                                .iter()
                                .find(|el| el.descriptor.eq(descriptor))
                                .unwrap()
                                .all_tasks_text_outputs()?
                                .get(0)
                                .unwrap()
                                .to_owned();
                            // self.text_storage_repository
                            //     .insert(TextStorage {
                            //         key: id.to_owned(),
                            //         value: "".to_string(),
                            //     })
                            //     .await?;
                            CollectTo::Text { id }
                        }
                        _ => unreachable!(),
                    };
                    // 解析收集规则
                    let rule = match collected_out.collecting.to_owned() {
                        RepoCollectRule::Regex(regex) => CollectRule::Regex(regex),
                        RepoCollectRule::BottomLines(line_count) => {
                            CollectRule::BottomLines(line_count)
                        }
                        RepoCollectRule::TopLines(line_count) => CollectRule::TopLines(line_count),
                    };
                    output_collects.push(CollectOutput {
                        from,
                        rule,
                        to,
                        optional: *optional,
                    });
                }
                OutputSlot::File {
                    descriptor: usecase_outslot_descriptor,
                    origin,
                    optional,
                    ..
                } => {
                    let task_output_slot = node_spec.output_slot(usecase_outslot_descriptor);
                    match origin {
                        FileOutOrigin::CollectedOut(collector_descriptor) => {
                            let collected_out = collected_outs
                                .iter()
                                .find(|el| el.descriptor.eq(collector_descriptor))
                                .unwrap();
                            // 解析从哪收集
                            let from = match collected_out.from.to_owned() {
                                RepoCollectFrom::FileOut(fileout_descriptor) => {
                                    // 因为文件名有可能被通过输入插槽改写，不能直接使用软件包中定义的输出文件默认名字
                                    let mut path = String::default();
                                    for out_slot in usecase_spec.output_slots.iter() {
                                        if let OutputSlot::File {
                                            descriptor, origin, ..
                                        } = out_slot
                                        {
                                            if descriptor.eq(&fileout_descriptor) {
                                                match origin {
                                                    FileOutOrigin::CollectedOut(_) => {
                                                        todo!()
                                                    }
                                                    FileOutOrigin::UsecaseOut(
                                                        file_out_and_appointed_by,
                                                    ) => {
                                                        let filesome_output = filesome_output_materials.iter().find(|el|el.descriptor.eq(&file_out_and_appointed_by.file_out_material_descriptor)).unwrap();
                                                        let out_path_alter =
                                                            match file_out_and_appointed_by
                                                                .kind
                                                                .to_owned()
                                                            {
                                                                AppointedBy::Material => None,
                                                                AppointedBy::InputSlot {
                                                                    text_input_descriptor,
                                                                } => {
                                                                    match node_spec.input_slot(&text_input_descriptor).kind.to_owned(){
                                                                            NodeInputSlotKind::Text { contents, .. } => {
                                                                                Some(self.text_storage_repository.get_by_id(*contents.unwrap().get(0).unwrap()).await?.value)
                                                                            },
                                                                            _ => unreachable!()
                                                                        }
                                                                }
                                                            };
                                                        path = out_path_alter.unwrap_or(
                                                            match filesome_output
                                                                .file_kind
                                                                .to_owned()
                                                            {
                                                                FileKind::Normal(path) => path,
                                                                FileKind::Batched(path) => path,
                                                            },
                                                        );
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    CollectFrom::FileOut { path }
                                }
                                RepoCollectFrom::Stdout => CollectFrom::Stdout,
                                RepoCollectFrom::Stderr => CollectFrom::Stderr,
                            };
                            // 解析收集到哪里去
                            let to = match collected_out.to.to_owned() {
                                RepoCollectTo::File(out_file) => {
                                    let id = node_spec
                                        .output_slots
                                        .iter()
                                        .find(|el| el.descriptor.eq(usecase_outslot_descriptor))
                                        .unwrap()
                                        .all_tasks_file_outputs()?
                                        .get(0)
                                        .unwrap()
                                        .to_owned();

                                    CollectTo::File {
                                        path: out_file.get_path(),
                                        id,
                                    }
                                }
                                _ => unreachable!(),
                            };
                            // 解析收集规则
                            let rule = match collected_out.collecting.to_owned() {
                                RepoCollectRule::Regex(regex) => CollectRule::Regex(regex),
                                RepoCollectRule::BottomLines(line_count) => {
                                    CollectRule::BottomLines(line_count)
                                }
                                RepoCollectRule::TopLines(line_count) => {
                                    CollectRule::TopLines(line_count)
                                }
                            };
                            output_collects.push(CollectOutput {
                                from,
                                rule,
                                to,
                                optional: *optional,
                            });
                        }
                        FileOutOrigin::UsecaseOut(file_out_and_appointed_by) => {
                            let filesome_output = filesome_output_materials
                                .iter()
                                .find(|el| {
                                    el.descriptor
                                        .eq(&file_out_and_appointed_by.file_out_material_descriptor)
                                })
                                .unwrap();
                            let out_path_alter = match file_out_and_appointed_by.kind.to_owned() {
                                AppointedBy::Material => None,
                                AppointedBy::InputSlot {
                                    text_input_descriptor,
                                } => {
                                    match node_spec
                                        .input_slot(&text_input_descriptor)
                                        .kind
                                        .to_owned()
                                    {
                                        NodeInputSlotKind::Text { contents, .. } => Some(
                                            self.text_storage_repository
                                                .get_by_id(*contents.unwrap().get(0).unwrap())
                                                .await?
                                                .value,
                                        ),
                                        _ => unreachable!(),
                                    }
                                }
                            };
                            match &filesome_output.file_kind {
                                FileKind::Normal(file_name) => {
                                    let out_file_id =
                                        task_output_slot.all_tasks_file_outputs()?.get(0).unwrap();
                                    upload_files.push(UploadFile {
                                        file_id: *out_file_id,
                                        path: out_path_alter.unwrap_or(file_name.to_owned()),
                                        is_package: false,
                                        validator: out_descriptor_to_validator
                                            .get(usecase_outslot_descriptor)
                                            .unwrap()
                                            .to_owned()
                                            .map(|v| v.into()),
                                        optional: *optional,
                                    });
                                }
                                FileKind::Batched(wild_card) => {
                                    let out_file_or_zip_id =
                                        task_output_slot.all_tasks_file_outputs()?.get(0).unwrap();
                                    upload_files.push(UploadFile {
                                        file_id: out_file_or_zip_id.to_owned(),
                                        path: out_path_alter.unwrap_or(wild_card.to_owned()),
                                        is_package: true,
                                        validator: out_descriptor_to_validator
                                            .get(usecase_outslot_descriptor)
                                            .unwrap()
                                            .to_owned()
                                            .map(|v| v.into()),
                                        optional: *optional,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
        let mut argument_formats_sorts = argument_formats_sorts.into_iter().collect::<Vec<_>>();
        argument_formats_sorts.sort_by(|a, b| a.0.cmp(&b.0));
        let arguments = argument_formats_sorts
            .iter_mut()
            .map(|(_, format_fill)| {
                let format = &mut format_fill.format;
                let placeholder_fill_map = &format_fill.placeholder_fill_map;
                let mut placeholder_fill_vec = placeholder_fill_map.iter().collect::<Vec<_>>();
                placeholder_fill_vec.sort_by(|a, b| a.0.cmp(b.0));
                for placeholder_fill in placeholder_fill_vec.iter() {
                    *format = format.replacen(
                        "{{}}",
                        if let Some(x) = placeholder_fill.1 {
                            x
                        } else {
                            ""
                        },
                        1,
                    );
                }
                format.to_owned()
            })
            .collect();

        let environments = environment_formats_map
            .iter_mut()
            .map(|(key, format_fill)| {
                let format = &mut format_fill.format;
                let placeholder_fill_map = &format_fill.placeholder_fill_map;
                let mut placeholder_fill_vec = placeholder_fill_map.iter().collect::<Vec<_>>();
                placeholder_fill_vec.sort_by(|a, b| a.0.cmp(b.0));
                for placeholder_fill in placeholder_fill_vec.iter() {
                    *format = format.replacen(
                        "{{}}",
                        if let Some(x) = placeholder_fill.1 {
                            x
                        } else {
                            ""
                        },
                        1,
                    );
                }
                (key.to_owned(), format.to_owned())
            })
            .collect();

        let (software_name, version, require_install_arguments) = match software_spec.to_owned() {
            RepoSoftwareSpec::Spack {
                name,
                argument_list,
            } => (
                name,
                argument_list.get(0).cloned().unwrap_or_default().replace('@', ""),
                argument_list,
            ),
            RepoSoftwareSpec::Singularity { .. } => {
                (String::default(), String::default(), Vec::default())
            }
        };

        if !self
            .software_block_list_repository
            .is_software_version_blocked(&software_name, &version)
            .await?
            && self
                .installed_software_repository
                .is_software_satisfied(&software_name, &require_install_arguments)
                .await?
        {
            tasks.push(StartTaskBody::DeploySoftware(DeploySoftware {
                facility_kind: FacilityKind::from(software_spec.to_owned()),
            }));
        }

        for download_file in download_files {
            tasks.push(StartTaskBody::DownloadFile(download_file));
        }
        tasks.push(StartTaskBody::ExecuteUsecase(ExecuteUsecase {
            name: usecase_spec.command_file.to_owned(),
            arguments,
            environments,
            facility_kind: FacilityKind::from(software_spec.to_owned()),
            std_in,
            requirements: override_requirements
                .map(|r| r.into())
                .or(requirements.map(|r| r.into())),
        }));

        for collect_output in output_collects {
            tasks.push(StartTaskBody::CollectOutput(collect_output));
        }

        for upload_file in upload_files {
            tasks.push(StartTaskBody::UploadFile(upload_file));
        }
        Ok(tasks)
    }

    /// 返回模板填充完毕后的内容
    ///
    /// # 参数
    ///
    /// * `template_content` - 模板内容
    /// * `kv_json` - 模板内容填充键值对
    fn get_template_file_result<T>(template_content: &str, kv_json: T) -> anyhow::Result<String>
    where
        T: Serialize,
    {
        let mut reg = Handlebars::new();
        reg.register_template_string("template_content", template_content)?;
        Ok(reg.render("template_content", &kv_json)?)
    }

    /// 根据参数描述符获得参数值 format、以及初始化表示该 format 各占位符填充值的 HashMap
    ///
    /// # 参数
    ///
    /// * `argument_materials` - 软件包中参数材料列表
    /// * `descriptor` - 参数描述符
    fn argument_format(argument_materials: &[Argument], descriptor: &str) -> FormatFill {
        let value_format = argument_materials
            .iter()
            .find(|el| el.descriptor.eq(descriptor))
            .unwrap()
            .value_format
            .to_owned();
        FormatFill {
            format: value_format,
            placeholder_fill_map: HashMap::new(),
        }
    }

    /// 根据环境变量描述符获得键、参数值 format、以及初始化表示该 format 各占位符填充值的 HashMap
    ///
    /// # 参数
    ///
    /// * `environment_materials` - 软件包中环境变量材料列表
    /// * `descriptor` - 环境变量描述符
    fn environment_kv_format(
        environment_materials: &[Environment],
        descriptor: &str,
    ) -> (String, FormatFill) {
        let environment =
            environment_materials.iter().find(|el| el.descriptor.eq(descriptor)).unwrap();
        (
            environment.key.to_owned(),
            FormatFill {
                format: environment.value_format.to_owned(),
                placeholder_fill_map: HashMap::new(),
            },
        )
    }

    /// 得到节点实例某输入插槽上的输入
    async fn get_content(
        &self,
        node_spec: &NodeSpec,
        input_slot_descriptor: &str,
    ) -> anyhow::Result<Option<InContent>> {
        let node_input_slot = node_spec.input_slot(input_slot_descriptor);
        // 如果输入插槽没有输入且该输入插槽的输入是可选的
        if node_input_slot.is_empty_input() && node_input_slot.optional {
            return Ok(None);
        }

        match node_input_slot.kind.clone() {
            NodeInputSlotKind::Text { contents, .. } => {
                let mut texts = vec![];

                for content in contents.as_ref().unwrap() {
                    texts.push(self.text_storage_repository.get_by_id(*content).await?.value)
                }
                Ok(Some(InContent {
                    args: texts.join(" "),
                    infiles: vec![],
                }))
            }
            NodeInputSlotKind::File {
                contents,
                expected_file_name,
                is_batch,
            } => {
                let mut file_names = vec![];
                let mut file_infos = vec![];
                for content in contents.as_ref().unwrap().iter() {
                    if let Some(ref expected_file_name) = expected_file_name {
                        file_names.push(expected_file_name.to_owned());
                        file_infos.push(InFileInfo {
                            path: expected_file_name.to_owned(),
                            is_packaged: is_batch,
                            meta_id: content.file_metadata_id,
                        });
                    } else {
                        file_names.push(content.file_metadata_name.to_owned());
                        file_infos.push(InFileInfo {
                            path: content.file_metadata_name.to_owned(),
                            is_packaged: is_batch,
                            meta_id: content.file_metadata_id.to_owned(),
                        });
                    }
                }
                Ok(Some(InContent {
                    args: file_names.join(" "),
                    infiles: file_infos,
                }))
            }
            NodeInputSlotKind::Unknown => unreachable!(),
        }
    }
}
