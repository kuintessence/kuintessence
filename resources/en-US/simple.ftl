internal-error = Internal error

flash-upload = The uploading file has the same hash with already uploaded file: { $alreadyId }, so a flash upload was implemented instead.
conflicted-id = A not completed multipart with meta-id:{ $metaId } exists.
conflicted-hash = A not completed multipart, id: { $metaId } with hash:{ $hash } exists.
multipart-not-found = The unfinished multipart with meta-id: { $metaId } can't be found.
no-such-part = The unfinished multipart with meta-id: { $metaId } doesn't have part nth: { $partNth }.
unmatched-hash = File: { $metaId }'s completed hash: { $completedHash } is unmatched with provided hash: { $originalHash }.

empty-node-drafts = No node drafts in workflow draft.
json-schema = Json schema validate error.
no-such-node = There is no node with id: { $id }.
no-such-input-slot = There is no such input-slot with descriptor: { $descriptor } in node with id: { $nodeId }.
no-such-output-slot = There is no such output-slot with descriptor: { $descriptor } in node with id: { $nodeId }.
not-single-input-with-match-regex = MatchRegex batch type in node: { $nodeId }, input-slot: { $descriptor } can only have exactly one input.
original-batch-inputs-less-tan-one = Origin batch type in node: { $nodeId }, input-slot: { $descriptor }'s input must be more than one.
no-such-batch-outputs = FromBatchOutputs batch type in node: { $nodeId }, slot: { $descriptor } doesn't have matched out node and slot.
relied-node-is-not-batched = The node: { $fromNodeId } corresponding to FromBatchOutputs batch type in node: { $node-id }, slot: { $descriptor } doesn't have batch-strategy.
relied-slot-is-not-batched = The slot: { $fromDescriptor } in node: { $fromNodeId}, corresponding to FromBatchOutputs batch type in node: { $nodeId }, slot: { $descriptor } isn't batched.
mismatched-paired-slot = The from-slot with descriptor: { $fromDescriptor} in from-node: { $fromNodeId } doesn't have the same input kind with to-slot with descriptor: { $toDescriptor } in to-node: { $toNodeId }.
relied-slot-contents-not-empty = The input-slot:{ $toDescriptor } in node: { $toNodeId } is relied on out-slot: { $fromDescriptor } in node: { $fromNodeId }, which can not have contents.
no-relied-slot-contents-empty = The input-slot:{ $descriptor } in node: { $nodeId } is not relied on other out-slot but doesn't have contents.
file-metadata-not-uploaded = The fileMetadata with id: { $fileMetadataId } in node: { $nodeId }, slot: { $descriptor } is not uploaded.
dulplicated-batch-strategy = A slot can only have one batch strategy, but the slot { $inputSlotDescriptor } has multiple batch strategies.
at-least-one-queue = Manual and Prefer must select one queue at least.
batch-input-not-offer = The optional in batch input must not be true, but { $nodeId }'s input-slot: { $slot }'s optional is true.
