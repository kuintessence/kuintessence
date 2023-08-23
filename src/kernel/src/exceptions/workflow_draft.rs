use thiserror::Error;
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum WorkflowDraftException {
    #[error("Json schema validate error: {reason}")]
    JSONSchema { reason: String },
    #[error("There is no node with id: {id}!")]
    NoSuchNode { id: Uuid },
    #[error("There is no input_slot with descriptor: {descriptor} in node with id: {node_id}!")]
    NoSuchInputSlot { node_id: Uuid, descriptor: String },
    #[error("There is no output_slot with descriptor: {descriptor} in node with id: {node_id}!")]
    NoSuchOutputSlot { node_id: Uuid, descriptor: String },
    #[error(
        "MatchRegex batch type in node: {node_id}, slot: {descriptor} can only have exactly one input!"
    )]
    NotSingleInputWithMatchRegex { node_id: Uuid, descriptor: String },
    #[error(
        "Origin batch type in node: {node_id}, slot: {descriptor}'s input must be greater than one!"
    )]
    OriginalBatchInputsLessThanOne { node_id: Uuid, descriptor: String },
    #[error(
        "FromBatchOutputs batch type in node: {node_id}, slot: {descriptor} doesn't have paired out_slot node and slot"
    )]
    NoSuchBatchOutputs { node_id: Uuid, descriptor: String },
    #[error(
        "The node: {from_node_id} corresponding to FromBatchOutputs batch type in node: {node_id}, slot: {descriptor} doesn't have batch_strategy."
    )]
    ReliedNodeIsNotBatched {
        from_node_id: Uuid,
        node_id: Uuid,
        descriptor: String,
    },
    #[error(
        "The node: {from_node_id}, slot: {from_descriptor} corresponding to FromBatchOutputs batch type in node: {node_id}, slot: {descriptor} isn't batched."
    )]
    ReliedSlotIsNotBatched {
        from_node_id: Uuid,
        from_descriptor: String,
        node_id: Uuid,
        descriptor: String,
    },
    #[error("The file with id: {file_metadata_id} doesn't exist in db!")]
    NoneFile { file_metadata_id: Uuid },
    #[error("The from_slot with descriptor: {from_descriptor} in from_node: {from_node_id} doesn't have the same input kind with to_slot with descriptor: {to_descriptor} in to_node: {to_node_id} !")]
    MismatchPairedSlot {
        from_node_id: Uuid,
        from_descriptor: String,
        to_node_id: Uuid,
        to_descriptor: String,
    },
    #[error("The input_slot:{to_descriptor} in node: {to_node_id} is relied on out_slot: {from_descriptor} in node: {from_node_id}, which can not have contents.")]
    ReliedSlotContentsNotEmpty {
        from_node_id: Uuid,
        from_descriptor: String,
        to_node_id: Uuid,
        to_descriptor: String,
    },
    #[error("The input_slot:{descriptor} in node: {node_id} is not relied on other out_slot but doesn't have contents.")]
    NoReliedSlotContentsEmpty { node_id: Uuid, descriptor: String },
    #[error("The fileMetadata with id: {file_metadata_id} in node: {node_id}, slot: {slot_descriptor} is not uploaded.")]
    FileMetadataNotUploaded {
        file_metadata_id: Uuid,
        node_id: Uuid,
        slot_descriptor: String,
    },

    #[error("A slot can only have one batch strategy, but the slot {input_slot_descriptor} has multiple batch strategies!")]
    DulplicatedBatchStrategy { input_slot_descriptor: String },
    #[error("Manual and Prefer must select one cluster at least.")]
    AtLeastOneCluster,
    #[error("The optional in batch input must not be true, but optional is true!")]
    BatchInputNotOffer,
    #[error("Unknown data store error")]
    Unknown,
}
