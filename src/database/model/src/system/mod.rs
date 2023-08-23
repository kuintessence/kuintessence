mod available_zone;
mod chat;
mod cluster;
mod cluster_id_settings;
mod cluster_resource;
mod custom_node;
mod dictionary;
mod dictionary_value;
mod file_metadata;
mod file_storage;
mod file_transmit;
mod flow_draft;
mod flow_instance;
mod flow_instance_billing;
mod flow_template;
mod message;
mod net_disk;
mod node_draft_file;
mod node_instance;
mod node_instance_billing;
mod node_instance_file;
mod notification;
mod region;
mod storage_server;
mod user_log;
mod user_resource;
mod user_webhook;
mod work_order;

pub mod prelude {
    pub use super::{
        available_zone::{
            ActiveModel as AvailableZoneActiveModel, Column as AvailableZoneColumn,
            Entity as AvailableZoneEntity, Model as AvailableZoneModel,
            PrimaryKey as AvailableZonePrimaryKey, Relation as AvailableZoneRelation,
        },
        cluster::{
            ActiveModel as ClusterActiveModel, Column as ClusterColumn, Entity as ClusterEntity,
            Model as ClusterModel, PrimaryKey as ClusterPrimaryKey, Relation as ClusterRelation,
        },
        cluster_id_settings::{
            ActiveModel as ClusterIdSettingsActiveModel, Column as ClusterIdSettingsColumn,
            Entity as ClusterIdSettingsEntity, Model as ClusterIdSettingsModel,
            PrimaryKey as ClusterIdSettingsPrimaryKey, Relation as ClusterIdSettingsRelation,
        },
        cluster_resource::{
            ActiveModel as ClusterResourceActiveModel, Column as ClusterResourceColumn,
            Entity as ClusterResourceEntity, Model as ClusterResourceModel,
            PrimaryKey as ClusterResourcePrimaryKey, Relation as ClusterResourceRelation,
        },
        custom_node::{
            ActiveModel as CustomNodeActiveModel, Column as CustomNodeColumn,
            Entity as CustomNodeEntity, Model as CustomNodeModel,
            PrimaryKey as CustomNodePrimaryKey, Relation as CustomNodeRelation,
        },
        dictionary::{
            ActiveModel as DictionaryActiveModel, Column as DictionaryColumn,
            Entity as DictionaryEntity, Model as DictionaryModel,
            PrimaryKey as DictionaryPrimaryKey, Relation as DictionaryRelation,
        },
        dictionary_value::{
            ActiveModel as DictionaryValueActiveModel, Column as DictionaryValueColumn,
            Entity as DictionaryValueEntity, Model as DictionaryValueModel,
            PrimaryKey as DictionaryValuePrimaryKey, Relation as DictionaryValueRelation,
        },
        file_metadata::{
            ActiveModel as FileMetadataActiveModel, Column as FileMetadataColumn,
            Entity as FileMetadataEntity, Model as FileMetadataModel,
            PrimaryKey as FileMetadataPrimaryKey, Relation as FileMetadataRelation,
        },
        file_storage::{
            ActiveModel as FileStorageActiveModel, Column as FileStorageColumn,
            Entity as FileStorageEntity, Model as FileStorageModel,
            PrimaryKey as FileStoragePrimaryKey, Relation as FileStorageRelation,
        },
        file_transmit::{
            ActiveModel as FileTransmitActiveModel, Column as FileTransmitColumn,
            Entity as FileTransmitEntity, Model as FileTransmitModel,
            PrimaryKey as FileTransmitPrimaryKey, Relation as FileTransmitRelation,
        },
        flow_draft::{
            ActiveModel as FlowDraftActiveModel, Column as FlowDraftColumn,
            Entity as FlowDraftEntity, Model as FlowDraftModel, PrimaryKey as FlowDraftPrimaryKey,
            Relation as FlowDraftRelation,
        },
        flow_instance::{
            ActiveModel as FlowInstanceActiveModel, Column as FlowInstanceColumn,
            Entity as FlowInstanceEntity, Model as FlowInstanceModel,
            PrimaryKey as FlowInstancePrimaryKey, Relation as FlowInstanceRelation,
        },
        flow_instance_billing::{
            ActiveModel as FlowInstanceBillingActiveModel, Column as FlowInstanceBillingColumn,
            Entity as FlowInstanceBillingEntity, Model as FlowInstanceBillingModel,
            PrimaryKey as FlowInstanceBillingPrimaryKey, Relation as FlowInstanceBillingRelation,
        },
        flow_template::{
            ActiveModel as FlowTemplateActiveModel, Column as FlowTemplateColumn,
            Entity as FlowTemplateEntity, Model as FlowTemplateModel,
            PrimaryKey as FlowTemplatePrimaryKey, Relation as FlowTemplateRelation,
        },
        net_disk::{
            ActiveModel as FileSystemActiveModel, Column as FileSystemColumn,
            Entity as FileSystemEntity, Model as FileSystemModel,
            PrimaryKey as FileSystemPrimaryKey, Relation as FileSystemRelation,
        },
        node_draft_file::{
            ActiveModel as NodeDraftFileActiveModel, Column as NodeDraftFileColumn,
            Entity as NodeDraftFileEntity, Model as NodeDraftFileModel,
            PrimaryKey as NodeDraftFilePrimaryKey, Relation as NodeDraftFileRelation,
        },
        node_instance::{
            ActiveModel as NodeInstanceActiveModel, Column as NodeInstanceColumn,
            Entity as NodeInstanceEntity, Model as NodeInstanceModel,
            PrimaryKey as NodeInstancePrimaryKey, Relation as NodeInstanceRelation,
        },
        node_instance_billing::{
            ActiveModel as NodeInstanceBillingActiveModel, Column as NodeInstanceBillingColumn,
            Entity as NodeInstanceBillingEntity, Model as NodeInstanceBillingModel,
            PrimaryKey as NodeInstanceBillingPrimaryKey, Relation as NodeInstanceBillingRelation,
        },
        node_instance_file::{
            ActiveModel as NodeInstanceFileActiveModel, Column as NodeInstanceFileColumn,
            Entity as NodeInstanceFileEntity, Model as NodeInstanceFileModel,
            PrimaryKey as NodeInstanceFilePrimaryKey, Relation as NodeInstanceFileRelation,
        },
        notification::{
            ActiveModel as NotificationActiveModel, Column as NotificationColumn,
            Entity as NotificationEntity, Model as NotificationModel,
            PrimaryKey as NotificationPrimaryKey, Relation as NotificationRelation,
        },
        region::{
            ActiveModel as RegionActiveModel, Column as RegionColumn, Entity as RegionEntity,
            Model as RegionModel, PrimaryKey as RegionPrimaryKey, Relation as RegionRelation,
        },
        storage_server::{
            ActiveModel as StorageServerActiveModel, Column as StorageServerColumn,
            Entity as StorageServerEntity, Model as StorageServerModel,
            PrimaryKey as StorageServerPrimaryKey, Relation as StorageServerRelation,
        },
        user_log::{
            ActiveModel as UserLogActiveModel, Column as UserLogColumn, Entity as UserLogEntity,
            Model as UserLogModel, PrimaryKey as UserLogPrimaryKey, Relation as UserLogRelation,
        },
        user_resource::{
            ActiveModel as UserResourceActiveModel, Column as UserResourceColumn,
            Entity as UserResourceEntity, Model as UserResourceModel,
            PrimaryKey as UserResourcePrimaryKey, Relation as UserResourceRelation,
        },
        user_webhook::{
            ActiveModel as UserWebhookActiveModel, Column as UserWebhookColumn,
            Entity as UserWebhookEntity, Model as UserWebhookModel,
            PrimaryKey as UserWebhookPrimaryKey, Relation as UserWebhookRelation,
        },
        work_order::{
            ActiveModel as WorkOrderActiveModel, Column as WorkOrderColumn,
            Entity as WorkOrderEntity, Model as WorkOrderModel, PrimaryKey as WorkOrderPrimaryKey,
            Relation as WorkOrderRelation,
        },
    };
}
