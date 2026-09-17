# 标准操作流程（SOP）

标准操作流程见四份角色手册。跨组件发布顺序和回滚边界见[结构化发布契约](https://github.com/kuintessence/kuintessence/blob/main/docs/manuals/release-contract.json)。

## 执行卡片

操作前确认账号与角色、组织与资源、任务或事件编号、操作入口和责任人。发布前还需准备版本、备份编号、回滚版本及逐条回滚命令。

执行记录至少包含：

- 前置输入和操作入口；
- 实际动作、页面状态或命令输出；
- 失败分支、停止条件和升级渠道；
- 时间阈值、观察时长、完成证据和交班人。

默认上报时限：用户提交后，提交状态连续 15 分钟无进展或异常仍未解决时，向下一责任人升级；该时限不要求作业在 15 分钟内运行完成。节点超过 5 分钟未上报心跳，或待处理事项超过 30 分钟时，也需升级。P0/P1 事件分别在 5/15 分钟内确认；发布后至少观察 30 分钟。部署单位可在值班制度中规定更短时限。

## 四类流程

- [科研用户：提交并取得结果](https://github.com/kuintessence/kuintessence/blob/main/docs/manuals/user-manual.md#sop)
- [算力提供方：巡检、变更与交班](https://github.com/kuintessence/kuintessence/blob/main/docs/manuals/compute-provider-manual.md#sop)
- [平台运营：告警与事件处置](https://github.com/kuintessence/kuintessence/blob/main/docs/manuals/platform-operator-manual.md#sop)
- [系统运维：发布、回滚与维护窗口](https://github.com/kuintessence/kuintessence/blob/main/docs/manuals/system-operations-manual.md#sop)

操作失败时，记录编号、时间、首个错误，以及审计记录或健康检查结果。缺少责任人、回滚所需信息或验证结果时，不要关闭事件或继续发布。交班时写明下一次检查时间和责任人。

返回[手册包与 SOP](./manuals)，或打开[完整文档索引](https://github.com/kuintessence/kuintessence/blob/main/docs/README.md)。
