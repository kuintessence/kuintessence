use crate::prelude::*;
use alice_architecture::repository::IReadOnlyRepository;
use evalexpr::{eval_float_with_context, Context, ContextWithMutableVariables};
use rust_decimal::Decimal;
use std::{collections::HashMap, str::FromStr, sync::Arc};
use uuid::Uuid;

pub struct FlowNodeBillingService {
    flow_bill_repo: Arc<dyn IFlowInstanceBillingRepository + Send + Sync>,
    node_bill_repo: Arc<dyn INodeInstanceBillingRepository + Send + Sync>,
    node_instance_repo: Arc<dyn IReadOnlyRepository<NodeInstance> + Send + Sync>,
    cluster_setting_repo: Arc<dyn IClusterIdSettingsRepository + Send + Sync>,
    flow_instance_repo: Arc<dyn IReadOnlyRepository<FlowInstance> + Send + Sync>,
    user_webhook_service: Arc<dyn IUserWebhookService + Send + Sync>,
}

impl FlowNodeBillingService {
    pub fn new(
        flow_bill_repo: Arc<dyn IFlowInstanceBillingRepository + Send + Sync>,
        node_bill_repo: Arc<dyn INodeInstanceBillingRepository + Send + Sync>,
        node_instance_repo: Arc<dyn IReadOnlyRepository<NodeInstance> + Send + Sync>,
        cluster_setting_repo: Arc<dyn IClusterIdSettingsRepository + Send + Sync>,
        flow_instance_repo: Arc<dyn IReadOnlyRepository<FlowInstance> + Send + Sync>,
        user_webhook_service: Arc<dyn IUserWebhookService + Send + Sync>,
    ) -> Self {
        Self {
            flow_bill_repo,
            node_bill_repo,
            node_instance_repo,
            cluster_setting_repo,
            flow_instance_repo,
            user_webhook_service,
        }
    }
}

#[async_trait::async_trait]
impl IFlowNodeBillingService for FlowNodeBillingService {
    async fn get_bill(
        &self,
        flow_instance_id: &str,
    ) -> anyhow::Result<(FlowInstanceBilling, Vec<NodeInstanceBilling>)> {
        let flow_bill = self.flow_bill_repo.get_by_flow_instance_id(flow_instance_id).await?;
        let node_bills = self.node_bill_repo.get_all_by_flow_instance_id(flow_instance_id).await?;
        Ok((flow_bill, node_bills))
    }

    async fn record_bill(&self, node_instance_id: &str) -> anyhow::Result<()> {
        let node_instance = self.node_instance_repo.get_by_id(node_instance_id).await?;
        let resource_meter = node_instance.resource_meter;
        let cluster_id = node_instance.cluster_id;
        let flow_instance_id = node_instance.flow_id;
        let flow_instance =
            self.flow_instance_repo.get_by_id(flow_instance_id.to_string().as_str()).await?;
        let user_id = flow_instance.user_id;
        let cluster_settings =
            self.cluster_setting_repo.get_by_cluster_id(&cluster_id.to_string()).await?;
        println!("CS:\n\n{cluster_settings:#?}");
        let formula = cluster_settings.formula;

        let (n_cpu, n_memory, n_storage, n_cpu_time, n_wall_time) = (
            resource_meter.cpu as f64,
            resource_meter.max_memory as f64,
            resource_meter.storage as f64,
            resource_meter.cpu_time as f64,
            resource_meter.wall_time as f64,
        );

        let (u_cpu, u_memory, u_storage, u_cpu_time, u_wall_time) = (
            cluster_settings.cpu.mantissa() as f64,
            cluster_settings.memory.mantissa() as f64,
            cluster_settings.storage.mantissa() as f64,
            cluster_settings.cpu_time.mantissa() as f64,
            cluster_settings.wall_time.mantissa() as f64,
        );

        let mut context = evalexpr::context_map! {
            "n_cpu" => n_cpu,
            "n_memory" => n_memory,
            "n_storage" => n_storage,
            "n_cpu_time" => n_cpu_time,
            "n_wall_time"=> n_wall_time,
            "u_cpu" => u_cpu,
            "u_memory" => u_memory,
            "u_storage" => u_storage,
            "u_cpu_time" => u_cpu_time,
            "u_wall_time"=> u_wall_time,
        }?;
        let mut prices = serde_json::from_str::<HashMap<String, String>>(&formula)?;
        for (arg, txt) in prices.iter_mut().filter(|(k, _)| k.ne(&"p_node")) {
            let result = eval_float_with_context(txt, &context)?;
            context.set_value(arg.into(), result.into())?;
            let result = Decimal::new(result as i64, 10);
            let var = arg
                .strip_prefix("p_")
                .ok_or(anyhow::anyhow!("prefix error: not start with 'p_'"))?;
            let n_var_context = context
                .get_value(&format!("n_{var}"))
                .ok_or(anyhow::anyhow!("No n_{var} context"))?
                .to_string();
            let u_var_context = context
                .get_value(&format!("u_{var}"))
                .ok_or(anyhow::anyhow!("No u_{var} context"))?
                .as_float()?;
            println!("{u_var_context}");
            let u_var_context = Decimal::new(u_var_context as i64, 10);
            println!("{u_var_context}");
            println!("{}", u_var_context);
            let value_txt = txt
                .replace(&format!("u_{var}"), &format!("u_{var}: ({u_var_context})"))
                .replace(&format!("n_{var}"), &format!("n_{var}: ({n_var_context})"));
            *txt = format!("{value_txt} = {result}");
        }
        let p_node_txt = prices.get_mut("p_node").ok_or(anyhow::anyhow!("No p_node in formula"))?;
        let p_node = eval_float_with_context(p_node_txt, &context)?;
        let p_node = Decimal::new(p_node as i64, 10);
        *p_node_txt = format!("{p_node_txt} = {p_node}");
        let node_bill = NodeInstanceBilling {
            id: Uuid::new_v4(),
            node_instance_id: Uuid::from_str(node_instance_id)?,
            flow_instance_id,
            cpu: n_cpu as i64,
            memory: n_memory as i64,
            storage: n_storage as i64,
            cpu_time: n_cpu_time as i64,
            wall_time: n_wall_time as i64,
            price: p_node,
            formula: serde_json::to_string(&prices)?,
        };
        let mut flow_bill = match self
            .flow_bill_repo
            .get_by_flow_instance_id(&flow_instance_id.to_string())
            .await
        {
            Ok(el) => el,
            Err(_) => {
                self.flow_bill_repo
                    .insert(FlowInstanceBilling {
                        id: Uuid::new_v4(),
                        flow_instance_id,
                        cpu: 0,
                        memory: 0,
                        storage: 0,
                        cpu_time: 0,
                        wall_time: 0,
                        total_price: Decimal::ZERO,
                        user_id,
                    })
                    .await?
            }
        };

        flow_bill.cpu += n_cpu as i64;
        flow_bill.memory += n_memory as i64;
        flow_bill.storage += n_storage as i64;
        flow_bill.cpu_time += n_cpu_time as i64;
        flow_bill.wall_time += n_wall_time as i64;
        flow_bill.total_price += p_node;

        self.node_bill_repo.insert(node_bill).await?;
        self.flow_bill_repo.insert_or_update(flow_bill).await?;
        self.flow_bill_repo.save_changed().await?;

        let flow_bill = self
            .flow_bill_repo
            .get_by_flow_instance_id(flow_instance_id.to_string().as_str())
            .await?;
        let node_bills = self
            .node_bill_repo
            .get_all_by_flow_instance_id(flow_instance_id.to_string().as_str())
            .await?;
        let message = serde_json::to_string(&(flow_bill, node_bills))?;
        self.user_webhook_service.send_message(&user_id.to_string(), &message).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eval_with_context() {
        let resource_meter = TaskUsedResource {
            cpu: 1,
            avg_memory: 1,
            max_memory: 1,
            storage: 1,
            wall_time: 1,
            cpu_time: 1,
            node: 1,
            start_time: 1235,
            end_time: 1425,
        };
        let (cpu, memory, storage, cpu_time, wall_time) = (
            resource_meter.cpu as f64,
            resource_meter.max_memory as f64,
            resource_meter.storage as f64,
            resource_meter.cpu_time as f64,
            resource_meter.wall_time as f64,
        );
        let cluster_settings = ClusterIdSettings {
            id: Uuid::default(),
            cluster_id: Uuid::default(),
            cpu: Decimal::new(1, 10),
            memory: Decimal::new(1, 10),
            storage: Decimal::new(1, 10),
            cpu_time: Decimal::new(1, 10),
            wall_time: Decimal::new(1, 10),
            formula: json!({
                "p_cpu": "n_cpu * u_cpu",
                "p_memory": "n_memory * u_memory",
                "p_storage": "n_storage * u_storage",
                "p_cpu_time": "n_cpu_time * u_cpu_time",
                "p_wall_time": "n_wall_time * u_wall_time",
                "p_node": "p_cpu + p_memory + p_storage + p_cpu_time + p_wall_time",
            })
            .to_string(),
        };
        let (u_cpu, u_memory, u_storage, u_cpu_time, u_wall_time) = (
            cluster_settings.cpu.mantissa() as f64,
            cluster_settings.memory.mantissa() as f64,
            cluster_settings.storage.mantissa() as f64,
            cluster_settings.cpu_time.mantissa() as f64,
            cluster_settings.wall_time.mantissa() as f64,
        );
        let formula = cluster_settings.formula;
        let mut prices = serde_json::from_str::<HashMap<String, String>>(&formula).unwrap();
        let mut context = evalexpr::context_map! {
            "n_cpu" => cpu,
            "n_memory" => memory,
            "n_storage" => storage,
            "n_cpu_time" => cpu_time,
            "n_wall_time"=> wall_time,
            "u_cpu" => u_cpu,
            "u_memory" => u_memory,
            "u_storage" => u_storage,
            "u_cpu_time" => u_cpu_time,
            "u_wall_time"=> u_wall_time,
        }
        .unwrap();

        for (arg, txt) in prices.iter_mut().filter(|(k, _)| k.ne(&"p_node")) {
            let result = eval_float_with_context(txt, &context).unwrap();
            context.set_value(arg.into(), result.into()).unwrap();
            let result = Decimal::new(result as i64, 10);
            let var = arg.strip_prefix("p_").ok_or("prefix error: not start with 'p_'").unwrap();
            let n_var_context = context
                .get_value(&format!("n_{var}"))
                .ok_or(anyhow::anyhow!("No n_{var} context"))
                .unwrap()
                .to_string();
            let u_var_context = context
                .get_value(&format!("u_{var}"))
                .ok_or(anyhow::anyhow!("No u_{var} context"))
                .unwrap()
                .as_float()
                .unwrap();
            println!("{u_var_context}");
            let u_var_context = Decimal::new(u_var_context as i64, 10);
            println!("{u_var_context}");
            println!("{}", u_var_context);
            let value_txt = txt
                .replace(&format!("u_{var}"), &format!("u_{var}: ({u_var_context})"))
                .replace(&format!("n_{var}"), &format!("n_{var}: ({n_var_context})"));
            *txt = format!("{value_txt} = {result}");
        }
        let p_node_txt = prices.get_mut("p_node").unwrap();
        let p_node = eval_float_with_context(p_node_txt, &context).unwrap();
        let p_node = Decimal::new(p_node as i64, 10);
        *p_node_txt = format!("{p_node_txt} = {p_node}");

        println!("{prices:#?}");
    }

    #[test]
    fn decimal_add() {
        let a = Decimal::new(100, 10);
        let b = Decimal::new(103, 10);
        let c = a + b;
        assert_eq!(c, Decimal::new(203, 10));
        assert_eq!(c.mantissa(), 203);
    }
    #[test]
    fn decimal_print() {
        let a = Decimal::new(1, 10);
        let b = format!("{a}");
        println!("{b}");
    }
}
