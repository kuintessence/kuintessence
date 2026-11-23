# 软件生态业务目录

软件生态包含软件、用例、脚本和工作流。名称说明用途，描述填写输入、处理内容、输出及必要运行条件。科学输入的质量分析与完整性校验属于业务功能；研发编号和发布过程记录保存在独立管理记录中。

科研软件与轻量编排软件使用不同名称和安装前缀。轻量编排只模拟数据传递与输出，不计算科研结果。模型、MPI、Python、目标原生锁、许可证和再分发条件按实际要求保留。

## 发布修订

签名 manifest 不可原地改写。使用原 releaseKey 和稳定 ecosystemKey，创建新版本、更新受影响的命名引用，重新计算 usecase specDigest 与 manifest 摘要，并由已有受信 Ed25519 发布键签名。

可用元数据修订工具生成新 manifest：

```sh
python3 scripts/ecosystem-revise-catalog.py manifest.json metadata.json updated-manifest.json --version 20261121.1
```

在已安装项目依赖的源码仓库运行，命令需要 Python 3 和项目指定版本的 Bun。输入可为 schemaVersion 1 manifest 或其签名 bundle，输出是待签名的新 manifest。工具使用 Registry 的 YAML 解析、清单校验和用例摘要算法。输出文件须使用新路径。

`metadata.json` 按 `ecosystemKey` 指定名称或描述，用例还可设置标签和领域，数据产品可设置标签。修订后的用例、脚本和模板采用新版本号。软件保留原版本号；工具根据用例声明的 Spack、Bare 或 Singularity 类型更新模板及嵌套工作流中的命名引用。同名同版本的 Spack 和站点软件可分别改名。修订脚本时，独立 Script 节点和用例前后处理钩子的 `scriptRef` 一起更新，钩子的输入、输出及运行时契约沿用原声明。参数默认值、脚本正文、Spack spec、站点程序路径和 SIF 摘要保持原值。

发布前核对脚本内容 SHA-256、命令默认值、输入归档、recipe/source/native lock 摘要、licensePolicy 和材料 binding，保证文案修订不改变执行内容。软件和数据许可审批沿用原规则，目录修订不会自动取得新许可。

## 激活与发现

通过已有 Ecosystem Release 导入接口验证签名，再按预期 active release 激活。并发发布导致 active 变化时重新审阅，不盲目重放。目录、搜索、详情和工作流选择器读取相同生效版本。工作流及作业表单的用例选择器按当前机构分页读取可见用例，完整加载上限为 1000 项；读取失败、范围内数量变化或超出上限时显示错误，不提供不完整的选择清单。

出现目录问题时使用原 release 回滚接口恢复上一版本；不要删除旧签名或修改历史原件。镜像回退和目录回滚分别处理。
