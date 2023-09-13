internal-error = 服务器内部错误

flash-upload = 正在上传的文件的哈希值跟已上传过的文件：{$alreadyId} 的哈希值相同，实施快传。
conflicted-id = 已存在 id 为：{ $metaId } 的未完成的分片上传。
conflicted-hash = 已存在 hash为：{ $hash } 的未完成的分片上传，id 为：{ $metaId }。
multipart-not-found = 没有该未完成的分片上传: { $metaId }。
no-such-part = 未完成的分片上传：{ $metaId } 没有第 { $nth } 片。
unmatched-hash = 文件: { $metaId } 有哈希冲突, 分片注册时哈希: { $registeredHash }, 但是分片合成的哈希值为: { $providedHash }。

empty-node-drafts = 工作流草稿中没有节点草稿。
json-schema =  Json Schema 验证错误。
no-such-node = 没有 id 为 { $id } 的节点。
no-such-input-slot =  id 为 { $nodeId } 的节点中不存在描述符为 { $descriptor } 的输入插槽。
no-such-output-slot = id 为 { $nodeId } 的节点中不存在描述符为 { $descriptor } 的输出插槽。
not-single-input-with-match-regex = 节点: { $nodeId }，输入插槽: { $descriptor } 中的 MatchRegex 批量策略只能有一个输入。
original-batch-inputs-less-tan-one = 节点: { $nodeId }，输入插槽: { $descriptor } 中的原始批量策略的输入必须大于 1。
no-such-batch-outputs = 节点：{ $nodeId }，输入插槽：{ $descriptor } 中的 FromBatchOutputs 批量策略没有匹配的输出节点和输出插槽。
relied-node-is-not-batched = 对应于节点：{ $nodeId }，输入插槽：{ $descriptor } 的 FromBatchOutputs 批量策略的节点：{ $fromNodeId } 没有批量策略。
relied-slot-is-not-batched = 对应于节点：{ $nodeId }，输入插槽：{ $descriptor } 的 FromBatchOutputs 批量策略的节点：{ $fromNodeId } 的输入插槽：{ $fromDescriptor } 不是批量输入。
mismatched-paired-slot = 被依赖节点: { $fromNodeId } 中描述符为 { $fromDescriptor} 的输出插槽与节点： { $toNodeId } 中描述符为 { $toDescriptor } 的输入插槽输入类型不同。
relied-slot-contents-not-empty = 节点: { $toNodeId } 中输入插槽:{ $toDescriptor } 依赖于节点: { $fromNodeId } 中的输出插槽: { $fromDescriptor }，其中不能有内容。
no-relied-slot-contents-empty = 节点: { $nodeId } 中的输入插槽:{ $descriptor } 不依赖于其他输出插槽，但没有内容。
file-metadata-not-uploaded = 节点：{ $nodeId }、输入插槽：{ $descriptor }中 id 为 { $fileMetadataId } 的文件未上传。
dulplicated-batch-strategy =  一个输入插槽只能有一个批量策略，但节点：{ $nodeId } 的输入插槽 { $descriptor } 有多个批量策略。
at-least-one-queue = “手动”和“偏好”类型的调度策略必须至少选择一个队列。
batch-input-not-offer = 批量输入中的 Optional 一定不能为 true，但 { $nodeId } 的输入插槽: { $descriptor } 的 Optional 为 true。
