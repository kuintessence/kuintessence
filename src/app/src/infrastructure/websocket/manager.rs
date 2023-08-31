use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use actix_web::web::Payload;
use actix_web::HttpRequest;
use actix_web::HttpResponse;
use alice_infrastructure::message_queue::InternalMessageQueueProducer;
use chrono::Utc;
use dashmap::DashMap;
use infrastructure_command::WsServerOperateCommand;
use uuid::Uuid;

use super::session::ManagerDirective;
use super::session::WsSession;

const TIMEOUT_SECS: u64 = 20 * 60;

pub struct WsManager {
    id2session: Arc<DashMap<Uuid, WsSession>>,
    interal_mq_producer: Arc<InternalMessageQueueProducer>,
    pub command_sender: flume::Sender<WsServerOperateCommand>,
}

impl WsManager {
    pub fn new(interal_mq_producer: Arc<InternalMessageQueueProducer>) -> Self {
        let (command_sender, cmd_receiver): (
            flume::Sender<WsServerOperateCommand>,
            flume::Receiver<WsServerOperateCommand>,
        ) = flume::unbounded();
        let id2session = Arc::new(DashMap::new());

        tokio::spawn(watch_command(cmd_receiver, id2session.clone()));

        tokio::spawn(watch_session_timeout(id2session.clone()));

        Self {
            id2session,
            interal_mq_producer,
            command_sender,
        }
    }
}

impl WsManager {
    /// Open new session.
    pub async fn open_session(
        &self,
        req: HttpRequest,
        body: Payload,
    ) -> Result<HttpResponse, actix_web::Error> {
        let id = Uuid::new_v4();
        let (response, session, msg_stream) = actix_ws::handle(&req, body)?;
        let ws_session = WsSession::new(
            session,
            msg_stream,
            self.interal_mq_producer.clone(),
            id,
            self.command_sender.clone(),
        );
        self.id2session.insert(id, ws_session);
        Ok(response)
    }
}

async fn watch_command(
    cmd_receiver: flume::Receiver<WsServerOperateCommand>,
    id2session: Arc<DashMap<Uuid, WsSession>>,
) {
    loop {
        match cmd_receiver.recv_async().await {
            Ok(msg) => match msg {
                WsServerOperateCommand::RemoveSession { id } => {
                    tracing::info!("Removing session, id={id}");
                    let _ = id2session.remove(&id);
                    log_active_sessions(&id2session);
                }
                WsServerOperateCommand::SendContentToSession { id, content } => {
                    let Some(session) = id2session.get(&id) else {
                        tracing::error!("No such session, id={id}");
                        continue;
                    };
                    session
                        .last_modified_timestamp
                        .store(Utc::now().timestamp(), Ordering::Relaxed);
                    if let Err(e) =
                        session.directive_sender.send_async(ManagerDirective::Text(content)).await
                    {
                        tracing::error!("Actix session closed before `WsSession`: {e}");
                    };
                }
            },
            Err(e) => tracing::error!("WsManager receive msg error: {e}"),
        }
    }
}

async fn watch_session_timeout(id2session: Arc<DashMap<Uuid, WsSession>>) {
    loop {
        tokio::time::sleep(Duration::from_secs(TIMEOUT_SECS)).await;

        let mut ids = vec![];

        for entry in id2session.iter() {
            let (id, session) = entry.pair();
            let now = Utc::now().timestamp();
            let last_modified_timestamp = &session.last_modified_timestamp;
            if now.gt(&(last_modified_timestamp.load(Ordering::Relaxed) + TIMEOUT_SECS as i64)) {
                if let Err(e) = session.directive_sender.send_async(ManagerDirective::Close).await {
                    tracing::error!("Actix session closed before `WsSession`: {e}");
                };
                ids.push(*id);
            }
        }

        for id in ids {
            id2session.remove(&id).unwrap();
        }
        log_active_sessions(&id2session);
    }
}

#[inline]
fn log_active_sessions(id2session: &DashMap<Uuid, WsSession>) {
    let ids: Vec<Uuid> = id2session.iter().map(|e| *e.key()).collect();
    tracing::info!("Active sessions after closing: {ids:?}");
}
