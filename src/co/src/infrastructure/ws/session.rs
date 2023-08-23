use super::IWsSession;
use actix_rt::task::JoinHandle;
use actix_web::{web::Payload, HttpRequest, HttpResponse};
use actix_ws::{Message, Session};
use alice_architecture::IMessageQueueProducerTemplate;
use alice_infrastructure::message_queue::InternalMessageQueueProducer;
use chrono::Utc;
use futures::StreamExt;
use kernel::prelude::*;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc,
};
use uuid::Uuid;

/// A client `web-socket` session.
pub struct WsSession {
    interal_mq_producer:
        Arc<dyn IMessageQueueProducerTemplate<(Uuid, ViewRealtimeCommand)> + Send + Sync>,
    id: Uuid,
    join_handle: Option<JoinHandle<()>>,
    session: Option<Session>,
    session_close_sender: flume::Sender<WsServerOperateCommand>,
    pub last_modified_timestamp: Arc<AtomicI64>,
    realtime_request_topic: String,
}

impl WsSession {
    pub fn new(
        interal_mq_producer: Arc<InternalMessageQueueProducer>,
        id: Uuid,
        session_close_sender: flume::Sender<WsServerOperateCommand>,
        realtime_request_topic: String,
    ) -> Self {
        Self {
            interal_mq_producer,
            id,
            join_handle: None,
            session: None,
            session_close_sender,
            last_modified_timestamp: Arc::new(AtomicI64::new(Utc::now().timestamp())),
            realtime_request_topic,
        }
    }
    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn join_handle(&self) -> Option<&JoinHandle<()>> {
        self.join_handle.as_ref()
    }
}

#[async_trait::async_trait(?Send)]
impl IWsSession for WsSession {
    /// Start the client session.
    async fn start(
        &mut self,
        req: HttpRequest,
        body: Payload,
    ) -> Result<HttpResponse, actix_web::Error> {
        let (response, mut session, mut msg_stream) = actix_ws::handle(&req, body)?;
        self.session = Some(session.clone());
        let session_close_sender = self.session_close_sender.clone();
        let id = self.id;
        let mq_producer = self.interal_mq_producer.clone();
        let last_modified_timestamp = self.last_modified_timestamp.clone();
        let realtime_request_topic = self.realtime_request_topic.clone();

        let join_handle = actix_web::rt::spawn(async move {
            let set = tokio::task::LocalSet::new();
            set.spawn_local(async move {
                while let Some(Ok(msg)) = msg_stream.next().await {
                    last_modified_timestamp.store(Utc::now().timestamp(), Ordering::Relaxed);

                    match msg {
                        Message::Text(s) => {
                            log::info!("Client: {id} receive msg: {s}");
                            if s.eq("myid") {
                                if let Err(e) = session.text(&id.to_string()).await {
                                    log::error!("Session was closed: {e}");
                                    break;
                                };
                                continue;
                            }
                            if s.eq("close") {
                                if let Err(e) = session.text("closed").await {
                                    log::error!("Session was closed: {e}");
                                    break;
                                };
                                break;
                            }

                            let mut command =
                                match serde_json::from_str::<ViewRealtimeCommand>(&String::from(s))
                                {
                                    Ok(el) => el,
                                    Err(e) => {
                                        log::error!("Deserialize ws msg error: {e}");
                                        if let Err(e) = session.text("specerr.").await {
                                            log::error!("Session closed: {e}");
                                            break;
                                        };
                                        continue;
                                    }
                                };
                            command.req_id = Uuid::new_v4();

                            if let Err(e) = mq_producer
                                .send_object(&(id, command), Some(&realtime_request_topic))
                                .await
                            {
                                log::error!("web_socket mq error: {}", e);
                            };
                        }
                        _ => break,
                    }
                }
                // Close due to client's behavior.
                if let Err(e) = session.close(None).await {
                    log::error!("client session close error: {}", e)
                };

                if let Err(e) = session_close_sender
                    .send_async(WsServerOperateCommand::CloseSession { client_id: id })
                    .await
                {
                    log::error!("close sender error: {}", e)
                };
            });
            set.await;
        });

        self.join_handle = Some(join_handle);
        Ok(response)
    }

    /// Send message to session.
    async fn send_message<T>(&mut self, msg: T) -> anyhow::Result<()>
    where
        T: Serialize + Send,
    {
        let session = self.session.as_mut().ok_or(anyhow::anyhow!("No session!"))?;

        session.text(serde_json::to_string(&msg)?).await?;
        Ok(())
    }
}

impl Drop for WsSession {
    fn drop(&mut self) {
        log::info!("Disconnect websocket client id: {}.", self.id)
    }
}
