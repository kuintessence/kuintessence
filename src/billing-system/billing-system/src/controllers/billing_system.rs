use crate::infrastructure::ServiceProvider;
use actix_web::web::Path;
use actix_web::{get, post, web};
use alice_architecture::base_dto::ResponseBase;
use alice_di::{actix_auto_inject, IServiceProvider};
use billing_system_kernel::prelude::*;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[actix_auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[post("billing-system/WebhookSubscribe")]
pub async fn webhook_subscribe(
    url: web::Json<Url>,
    #[inject] service: Arc<dyn IUserWebhookService + Send + Sync>,
) -> web::Json<ResponseBase<String>> {
    // let user_id = match user_info {
    //     Some(el) => el.user_id,
    //     None => return web::Json(ResponseBase::err(500, "Interval error")),
    // };
    let url = url.0;
    let user_id = url.user_id;
    let url = url.url;
    match service.register_webhook(&user_id, &url).await {
        Ok(_) => web::Json(ResponseBase::ok(None)),
        Err(_) => web::Json(ResponseBase::err(500, "Interval error")),
    }
}

#[actix_auto_inject(ServiceProvider, scoped = "user_info")]
#[alice_web_macro::http_request]
#[alice_web_macro::authorize]
#[get("billing-system/GetFlowNodesBill/{flow_instance_id}")]
pub async fn get_flow_nodes_bill(
    flow_instance_id: Path<String>,
    #[inject] service: Arc<dyn IFlowNodeBillingService + Send + Sync>,
) -> web::Json<ResponseBase<FlowBillResponse>> {
    match service.get_bill(&flow_instance_id).await {
        Ok(el) => {
            let response = FlowBillResponse::from(el);
            web::Json(ResponseBase::ok(Some(response)))
        }
        Err(e) => {
            log::error!("{e}");
            web::Json(ResponseBase::err(500, "Interval error"))
        }
    }
}

#[alice_di::auto_inject(ServiceProvider, scoped = "None")]
#[alice_web_macro::message_consumer]
pub async fn bill_consumer(
    #[inject] service: std::sync::Arc<dyn IFlowNodeBillingService + Send + Sync>,
    #[serialize] node_instance_id: NodeInstanceId,
) -> anyhow::Result<()> {
    log::info!("Receive msg: {node_instance_id:#?}");
    service.record_bill(&node_instance_id.node_instance_id).await
}
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NodeInstanceId {
    pub node_instance_id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Url {
    pub user_id: String,
    pub url: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowBillResponse {
    pub flow_bill: FlowBill,
    pub node_bill: Vec<NodeBill>,
}
impl From<(FlowInstanceBilling, Vec<NodeInstanceBilling>)> for FlowBillResponse {
    fn from(value: (FlowInstanceBilling, Vec<NodeInstanceBilling>)) -> Self {
        let (flow, nodes) = value;
        Self {
            flow_bill: FlowBill {
                cpu: flow.cpu,
                memory: flow.memory,
                storage: flow.storage,
                cpu_time: flow.cpu_time,
                wall_time: flow.wall_time,
                total_price: flow.total_price,
            },
            node_bill: nodes
                .into_iter()
                .map(|el| NodeBill {
                    id: el.id.to_string(),
                    cpu: el.cpu,
                    memory: el.memory,
                    storage: el.storage,
                    cpu_time: el.cpu_time,
                    wall_time: el.wall_time,
                    price: el.price,
                    formula: el.formula,
                })
                .collect::<Vec<_>>(),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowBill {
    pub cpu: i64,
    pub memory: i64,
    pub storage: i64,
    pub cpu_time: i64,
    pub wall_time: i64,
    pub total_price: Decimal,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeBill {
    pub id: String,
    pub cpu: i64,
    pub memory: i64,
    pub storage: i64,
    pub cpu_time: i64,
    pub wall_time: i64,
    pub price: Decimal,
    pub formula: String,
}
