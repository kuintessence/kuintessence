# 软件生态业务目录

软件生态包含软件、用例、脚本和工作流。名称说明用途，描述填写输入、处理内容、输出及必要运行条件。科学输入的质量分析与完整性校验属于业务功能；研发编号和发布过程记录保存在独立管理记录中。

科研软件与轻量编排软件使用不同名称和安装前缀。轻量编排只模拟数据传递与输出，不计算科研结果。模型、MPI、Python、目标原生锁、许可证和再分发条件按实际要求保留。

## 发布修订

签名 manifest 不可原地改写。使用原 releaseKey 和稳定 ecosystemKey，创建新版本、更新受影响的命名引用，重新计算 usecase specDigest 与 manifest 摘要，并由已有受信 Ed25519 发布键签名。旧版本、签名、作业和不可变执行引用保留。

可用元数据修订工具生成新 manifest：

```sh
python3 scripts/ecosystem-revise-catalog.py old-manifest.json metadata.json new-manifest.json --version 20261114.1
```

输入可为 schemaVersion 1 manifest 或其签名 bundle；输出仍需独立签名。Python 需要 PyYAML 读取已有工作流 YAML。metadata.json 按 ecosystemKey 指定 name、description、tags 或 domain，不接受命令、脚本、材料和许可覆盖。新 manifest 中的用例、工作流和脚本版本及内部命名引用同步更新。软件资产版本与实际 Spack spec 分开管理。

发布前核对脚本内容 SHA-256、命令默认值、输入归档、recipe/source/native lock 摘要、licensePolicy 和材料 binding，保证文案修订不改变执行内容。软件和数据许可审批沿用原规则，目录修订不会自动取得新许可。

## 激活与历史查询

通过已有 Ecosystem Release 导入接口验证签名，再按预期 active release 激活。并发发布导致 active 变化时重新审阅，不盲目重放。目录、搜索、详情和工作流选择器读取相同生效版本。

未纳入签名发布的旧资产可在发布替代版本后通过生命周期接口隐藏。隐藏只停止目录发现，历史编号与作业引用继续保留。用例和模板的列表、搜索、分类及命名发现遵守已有资产生命周期；历史按 ID 读取仍执行原权限。

出现目录问题时使用原 release 回滚接口恢复上一版本；不要删除旧签名或修改历史原件。镜像回退和目录回滚分别处理。
