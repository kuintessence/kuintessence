use anyhow::{anyhow, bail};
use database_model::queue;
use std::collections::HashMap;

use alice_architecture::model::AggregateRoot;
use once_cell::sync::Lazy;
use tokio::sync::Mutex;
use uuid::Uuid;

pub static QUEUE_ID_TO_CACHE_INFO: Lazy<Mutex<HashMap<Uuid, QueueCacheInfo>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Default, AggregateRoot)]
pub struct Queue {
    pub id: Uuid,
    pub name: String,
    pub topic_name: String,
    /// Queue memory size in Byte.
    pub memory: i64,
    pub memory_alert: Option<i64>,
    pub core_number: i64,
    pub core_number_alert: Option<i64>,
    pub storage_capacity: i64,
    pub storage_capacity_alert: Option<i64>,
    pub node_count: i64,
    pub max_node_count: Option<i64>,
    pub max_queuing_task_count: Option<i64>,
    pub max_running_task_count: Option<i64>,
    pub cache_info: Option<QueueCacheInfo>,
    pub enabled: bool,
}

impl From<queue::Model> for Queue {
    fn from(model: queue::Model) -> Self {
        let queue::Model {
            id,
            name,
            topic_name,
            memory,
            memory_alert,
            core_number,
            core_number_alert,
            storage_capacity,
            storage_capacity_alert,
            node_count,
            max_node_count,
            max_queuing_task_count,
            max_running_task_count,
            cluster_id: _,
            provider_id: _,
            description: _,
            scheduler_tech: _,
            enabled,
        } = model;

        Self {
            id,
            name,
            memory,
            memory_alert,
            core_number,
            core_number_alert,
            storage_capacity,
            storage_capacity_alert,
            node_count,
            max_node_count,
            max_queuing_task_count,
            max_running_task_count,
            topic_name,
            enabled,
            cache_info: Default::default(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct QueueCacheInfo {
    pub used: QueueResourceUsed,
    pub task_count: QueueTaskCount,
}

#[derive(Clone, Debug, Default)]
pub struct QueueResourceUsed {
    pub memory_used: i64,
    pub core_number_used: i64,
    pub storage_capacity_used: i64,
    pub node_number_used: i64,
}

#[derive(Clone, Debug, Default)]
pub struct QueueTaskCount {
    pub queuing_task_count: i64,
    pub running_task_count: i64,
}

impl Queue {
    pub async fn update_resource(queue_id: Uuid, resource: &QueueCacheInfo) {
        let mut queue_id_to_cache_info = QUEUE_ID_TO_CACHE_INFO.lock().await;
        let old = queue_id_to_cache_info.entry(queue_id).or_insert(QueueCacheInfo::default());
        *old = resource.to_owned();
    }

    pub async fn cache_resource(queue: &Queue) -> anyhow::Result<()> {
        let mut queue_id_to_cache_info = QUEUE_ID_TO_CACHE_INFO.lock().await;
        let old = queue_id_to_cache_info.entry(queue.id).or_insert(QueueCacheInfo::default());
        old.cache(queue)
    }

    pub async fn release_resource(queue_id: Uuid, resource: &QueueResourceUsed) {
        let mut queue_id_to_cache_info = QUEUE_ID_TO_CACHE_INFO.lock().await;
        let old = queue_id_to_cache_info.entry(queue_id).or_insert(QueueCacheInfo::default());
        old.release(resource);
    }

    pub async fn task_started(queue: &Queue) -> anyhow::Result<()> {
        let mut queue_id_to_cache_info = QUEUE_ID_TO_CACHE_INFO.lock().await;
        let old = queue_id_to_cache_info.entry(queue.id).or_insert(QueueCacheInfo::default());
        old.start_one(queue.max_running_task_count)
    }

    pub async fn is_resource_full(queue: &Queue) -> anyhow::Result<()> {
        let queue_id_to_cache_info = QUEUE_ID_TO_CACHE_INFO.lock().await;
        let cache_info = queue_id_to_cache_info.get(&queue.id);
        match cache_info {
            Some(el) => el.is_full(queue),
            None => Ok(()),
        }
    }

    pub async fn get_cache_info(queue_id: Uuid) -> anyhow::Result<QueueCacheInfo> {
        let queue_id_to_cache_info = QUEUE_ID_TO_CACHE_INFO.lock().await;
        let cache_info = queue_id_to_cache_info.get(&queue_id).ok_or(anyhow!(
            "queue id {} not found in queue id to cache info",
            queue_id
        ))?;
        Ok(cache_info.to_owned())
    }
}

impl QueueCacheInfo {
    pub fn is_full(&self, queue: &Queue) -> anyhow::Result<()> {
        if let Some(memory_alert) = queue.memory_alert {
            if self.used.memory_used >= memory_alert {
                bail!("queue memory full");
            }
        }
        if let Some(core_number_alert) = queue.core_number_alert {
            if self.used.core_number_used >= core_number_alert {
                bail!("queue core number full");
            }
        }
        if let Some(storage_capacity_alert) = queue.storage_capacity_alert {
            if self.used.storage_capacity_used >= storage_capacity_alert {
                bail!("queue storage capacity full");
            }
        }
        if let Some(max_node_count) = queue.max_node_count {
            if self.used.node_number_used >= max_node_count {
                bail!("queue node count full");
            }
        }
        if let Some(max_queuing_task_count) = queue.max_queuing_task_count {
            if self.task_count.queuing_task_count >= max_queuing_task_count {
                bail!("queue queuing task count full");
            }
        }
        if let Some(max_running_task_count) = queue.max_running_task_count {
            if self.task_count.running_task_count >= max_running_task_count {
                bail!("queue running task count full");
            }
        }
        Ok(())
    }

    pub fn cache(&mut self, queue: &Queue) -> anyhow::Result<()> {
        let cache_info = queue.cache_info.as_ref().ok_or(anyhow!("queue cache info is none"))?;
        let used = &cache_info.used;

        let memory_alert = queue.memory_alert;
        let core_number_alert = queue.core_number_alert;
        let storage_capacity_alert = queue.storage_capacity_alert;
        let max_node_count = queue.max_node_count;
        let max_queuing_task_count = queue.max_queuing_task_count;

        if let Some(memory_alert) = memory_alert {
            let new = self.used.memory_used + used.memory_used;
            if new >= memory_alert {
                bail!(
                    "queue memory used {} is greater than memory alert {}",
                    new,
                    memory_alert
                );
            }
            self.used.memory_used = new;
        }
        if let Some(core_number_alert) = core_number_alert {
            let new = self.used.core_number_used + used.core_number_used;
            if new >= core_number_alert {
                bail!(
                    "queue core number used {} is greater than core number alert {}",
                    new,
                    core_number_alert
                );
            }
            self.used.core_number_used = new;
        }
        if let Some(storage_capacity_alert) = storage_capacity_alert {
            let new = self.used.storage_capacity_used + used.storage_capacity_used;
            if new >= storage_capacity_alert {
                bail!(
                    "queue storage capacity used {} is greater than storage capacity alert {}",
                    new,
                    storage_capacity_alert
                );
            }
            self.used.storage_capacity_used = new;
        }
        if let Some(max_node_count) = max_node_count {
            let new = self.used.node_number_used + used.node_number_used;
            if new >= max_node_count {
                bail!(
                    "queue node number used {} is greater than max node count {}",
                    new,
                    max_node_count
                );
            }
            self.used.node_number_used = new;
        }
        if let Some(max_queuing_task_count) = max_queuing_task_count {
            let new = self.task_count.queuing_task_count + 1;
            if new >= max_queuing_task_count {
                bail!(
                    "queue queuing task count {} is greater than max queuing task count {}",
                    new,
                    max_queuing_task_count
                );
            }
            self.task_count.queuing_task_count = new;
        }
        Ok(())
    }

    pub fn release(&mut self, resource: &QueueResourceUsed) {
        self.used.memory_used -= resource.memory_used;
        self.used.core_number_used -= resource.core_number_used;
        self.used.storage_capacity_used -= resource.storage_capacity_used;
        self.used.node_number_used -= resource.node_number_used;
        self.task_count.running_task_count -= 1;
    }

    pub fn start_one(&mut self, max_running_task_count: Option<i64>) -> anyhow::Result<()> {
        self.task_count.queuing_task_count -= 1;
        if let Some(max_running_task_count) = max_running_task_count {
            let new = self.task_count.running_task_count + 1;
            if new >= max_running_task_count {
                bail!(
                    "queue running task count {} is greater than max running task count {}",
                    new,
                    max_running_task_count
                );
            }
            self.task_count.running_task_count = new;
        }
        Ok(())
    }
}
