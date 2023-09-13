use alice_architecture::response::derive::I18NEnum;
use thiserror::Error;
use uuid::Uuid;

pub type WorkflowResult<T> = Result<T, WorkflowException>;

#[derive(Error, Debug, I18NEnum)]
pub enum WorkflowException {
    #[error("No node drafts in workflow draft.")]
    #[status(200)]
    EmptyNodeDrafts,

    #[error("Json schema validate error: {reason}.")]
    #[status(201)]
    JSONSchema { reason: String },

    #[error("There is no node with id: {id}.")]
    #[status(202)]
    NoSuchNode { id: Uuid },

    #[error(
        "There is no such input_slot with descriptor: {descriptor} in node with id: {node_id}."
    )]
    #[status(203)]
    NoSuchInputSlot {
        #[content]
        node_id: Uuid,
        descriptor: String,
    },

    #[error(
        "There is no such output_slot with descriptor: {descriptor} in node with id: {node_id}."
    )]
    #[status(204)]
    NoSuchOutputSlot {
        #[content]
        node_id: Uuid,
        descriptor: String,
    },

    #[error(
        "MatchRegex batch type in node: {node_id}, input_slot: {descriptor} can only have exactly one input."
    )]
    #[status(205)]
    NotSingleInputWithMatchRegex {
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error(
        "Origin batch type in node: {node_id}, input_slot: {descriptor}'s input must be more than one."
    )]
    #[status(206)]
    OriginalBatchInputsLessThanOne {
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error(
        "FromBatchOutputs batch type in node: {node_id}, slot: {descriptor} doesn't have matched out node and slot."
    )]
    #[status(207)]
    NoSuchBatchOutputs {
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error(
        "The node: {from_node_id} corresponding to FromBatchOutputs batch type in node: {node_id}, slot: {descriptor} doesn't have batch_strategy."
    )]
    #[status(208)]
    ReliedNodeIsNotBatched {
        #[content]
        from_node_id: Uuid,
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error(
        "The node: {from_node_id}, slot: {from_descriptor} corresponding to FromBatchOutputs batch type in node: {node_id}, slot: {descriptor} isn't batched."
    )]
    #[status(209)]
    ReliedSlotIsNotBatched {
        #[content]
        from_node_id: Uuid,
        #[content]
        from_descriptor: String,
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error("The from_slot with descriptor: {from_descriptor} in from_node: {from_node_id} doesn't have the same input kind with to_slot with descriptor: {to_descriptor} in to_node: {to_node_id}.")]
    #[status(210)]
    MismatchedPairedSlot {
        #[content]
        from_node_id: Uuid,
        #[content]
        from_descriptor: String,
        #[content]
        to_node_id: Uuid,
        #[content]
        to_descriptor: String,
    },

    #[error("The input_slot:{to_descriptor} in node: {to_node_id} is relied on out_slot: {from_descriptor} in node: {from_node_id}, which can not have contents.")]
    #[status(211)]
    ReliedSlotContentsNotEmpty {
        #[content]
        from_node_id: Uuid,
        #[content]
        from_descriptor: String,
        #[content]
        to_node_id: Uuid,
        #[content]
        to_descriptor: String,
    },

    #[error("The input_slot:{descriptor} in node: {node_id} is not relied on other out_slot but doesn't have contents.")]
    #[status(212)]
    NoReliedSlotContentsEmpty {
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error("The fileMetadata with id: {file_metadata_id} in node: {node_id}, slot: {descriptor} is not uploaded.")]
    #[status(213)]
    FileMetadataNotUploaded {
        #[content]
        file_metadata_id: Uuid,
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error("A slot can only have one batch strategy, but the slot {descriptor} has multiple batch strategies.")]
    #[status(214)]
    DulplicatedBatchStrategy {
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error("Manual and Prefer must select one queue at least.")]
    #[status(215)]
    AtLeastOneQueue,

    #[error("The optional in batch input must not be true, but {node_id}'s input_slot: {descriptor}'s optional is true.")]
    #[status(216)]
    BatchInputNotOffer {
        #[content]
        node_id: Uuid,
        #[content]
        descriptor: String,
    },

    #[error("Workflow internal error: {source}")]
    #[status(500)]
    InternalError {
        #[source]
        source: anyhow::Error,
    },
}

impl From<anyhow::Error> for WorkflowException {
    fn from(e: anyhow::Error) -> Self {
        WorkflowException::InternalError { source: e }
    }
}
