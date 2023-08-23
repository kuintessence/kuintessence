use super::{session::WsSession, IWsManager, IWsSession};
use actix_web::{web::Payload, HttpRequest, HttpResponse};
use alice_infrastructure::message_queue::InternalMessageQueueProducer;
use chrono::Utc;
use kernel::prelude::*;
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};
use tokio::{runtime::Handle, sync::Mutex};
use uuid::Uuid;

fn ws_req_info_client_id_key_regex(client_id: Uuid) -> String {
    format!("*_{client_id}")
}

/// A manager that manage different `web-socket` session between different client.
pub struct WsManager {
    client_session_map: Arc<Mutex<HashMap<Uuid, Arc<Mutex<WsSession>>>>>,
    interal_mq_producer: Arc<InternalMessageQueueProducer>,
    pub ws_server_sender: flume::Sender<WsServerOperateCommand>,
    realtime_request_topic: String,
}

impl WsManager {
    pub fn new(
        interal_mq_producer: Arc<InternalMessageQueueProducer>,
        ws_req_info_repo: Arc<dyn IWsReqInfoRepo + Send + Sync>,
        realtime_request_topic: String,
    ) -> Self {
        let (session_close_sender, session_close_receiver): (
            flume::Sender<WsServerOperateCommand>,
            flume::Receiver<WsServerOperateCommand>,
        ) = flume::unbounded();
        let client_session_map =
            Arc::new(Mutex::new(HashMap::<Uuid, Arc<Mutex<WsSession>>>::new()));
        let client_session_map2 = client_session_map.clone();
        let client_session_map3 = client_session_map.clone();

        tokio::spawn(async move {
            loop {
                match session_close_receiver.recv_async().await {
                    Ok(msg) => match msg {
                        WsServerOperateCommand::CloseSession { client_id } => {
                            let mut client_session_map = client_session_map2.lock().await;
                            log::info!("Closing client id: {:#?}", client_id);
                            let _ = client_session_map.remove(&client_id);
                            log::info!("Client ids after close: {:?}", client_session_map.keys());
                            let _ = ws_req_info_repo
                                .delete_all_by_key_regex(&ws_req_info_client_id_key_regex(
                                    client_id,
                                ))
                                .await;
                        }
                        WsServerOperateCommand::SendContentToSession { content, client_id } => {
                            let session = match client_session_map2
                                .lock()
                                .await
                                .get_mut(&client_id)
                                .ok_or(anyhow::anyhow!("No such client id"))
                            {
                                Ok(el) => {
                                    el.lock()
                                        .await
                                        .last_modified_timestamp
                                        .store(Utc::now().timestamp(), Ordering::Relaxed);
                                    el.to_owned()
                                }
                                Err(e) => {
                                    log::error!("{e}");
                                    continue;
                                }
                            };
                            // block because Session doesn't implemented Send
                            tokio::task::block_in_place(move || {
                                Handle::current().block_on(async move {
                                    if let Err(e) =
                                        session.lock().await.send_message(&content).await
                                    {
                                        log::error!("Send content to session err: {e}")
                                    }
                                })
                            });
                        }
                    },
                    Err(e) => log::error!("WsManager receive msg error: {}", e),
                }
            }
        });
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(20 * 60)).await;
                let mut client_session_map = client_session_map3.lock().await;
                let mut ids = vec![];
                for (id, session) in client_session_map.iter() {
                    let session = session.lock().await;
                    let now = Utc::now().timestamp();
                    let last_modified_timestamp = &session.last_modified_timestamp;
                    if now.gt(&(last_modified_timestamp.load(Ordering::Relaxed) + 20 * 60)) {
                        if let Some(el) = session.join_handle() {
                            el.abort();
                            log::info!("Closing client id: {}", session.id());
                            ids.push(*id);
                        }
                    }
                }
                for id in ids {
                    client_session_map.remove(&id).unwrap();
                    log::info!(
                        "Active client ids after close: {:?}",
                        client_session_map.keys()
                    );
                }
            }
        });
        Self {
            client_session_map,
            interal_mq_producer,
            ws_server_sender: session_close_sender,
            realtime_request_topic,
        }
    }
    /// Get client session.
    async fn get_session(&self, id: Uuid) -> anyhow::Result<Arc<Mutex<WsSession>>> {
        Ok(self
            .client_session_map
            .lock()
            .await
            .get(&id)
            .ok_or(anyhow::anyhow!("No such client id"))?
            .clone())
    }
}

#[async_trait::async_trait(?Send)]
impl IWsManager for WsManager {
    /// Send message to client session.
    async fn send_message(&mut self, id: Uuid, msg: &str) -> anyhow::Result<()> {
        let session = self.get_session(id).await?;
        let mut x = session.lock().await;
        x.send_message(msg).await
    }

    /// Open client session.
    async fn open_session(
        &mut self,
        req: HttpRequest,
        body: Payload,
    ) -> Result<HttpResponse, actix_web::Error> {
        let client_id = Uuid::new_v4();
        let sender = self.ws_server_sender.clone();
        let mut ws_session = WsSession::new(
            self.interal_mq_producer.clone(),
            client_id,
            sender,
            self.realtime_request_topic.clone(),
        );
        let response = ws_session.start(req, body).await?;
        self.client_session_map
            .lock()
            .await
            .insert(client_id, Arc::new(Mutex::new(ws_session)));
        Ok(response)
    }
}
