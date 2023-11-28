use std::ops::Deref;
use std::sync::atomic::AtomicI64;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use actix_ws::Message;
use actix_ws::MessageStream;
use actix_ws::Session;
use alice_architecture::message_queue::producer::MessageQueueProducerTemplate;
use alice_infrastructure::message_queue::InternalMessageQueueProducer;
use chrono::Utc;
use infrastructure_command::WsServerOperateCommand;
use uuid::Uuid;

#[derive(Debug)]
pub enum ManagerDirective {
    Text(String),
    Close,
}

pub struct WsSession {
    pub id: Uuid,
    pub last_modified_timestamp: Arc<AtomicI64>,
    pub directive_sender: flume::Sender<ManagerDirective>,
}

impl WsSession {
    pub fn new(
        session: Session,
        msg_stream: MessageStream,
        interal_mq_producer: Arc<InternalMessageQueueProducer>,
        id: Uuid,
        close_informer: flume::Sender<WsServerOperateCommand>,
    ) -> Self {
        let (directive_sender, directive_receiver) = flume::bounded(32);
        let last_modified_timestamp = Arc::new(AtomicI64::new(Utc::now().timestamp()));

        actix_web::rt::spawn(watch_message(
            session,
            msg_stream,
            close_informer,
            id,
            interal_mq_producer,
            last_modified_timestamp.clone(),
            directive_receiver,
        ));

        Self {
            id,
            last_modified_timestamp,
            directive_sender,
        }
    }
}

impl Drop for WsSession {
    fn drop(&mut self) {
        tracing::info!("Disconnect websocket, session={}", self.id)
    }
}

async fn watch_message(
    mut session: Session,
    mut msg_stream: MessageStream,
    close_informer: flume::Sender<WsServerOperateCommand>,
    id: Uuid,
    mq_producer: Arc<dyn MessageQueueProducerTemplate<(Uuid, String)>>,
    last_modified_timestamp: Arc<AtomicI64>,
    directive_receiver: flume::Receiver<ManagerDirective>,
) {
    loop {
        tokio::select! {
            directive = directive_receiver.recv_async() => {
                match directive {
                    Ok(ManagerDirective::Text(msg)) => {
                        if session.text(msg).await.is_err() {
                            log_error_client_closed();
                            break;
                        }
                    }
                    Ok(ManagerDirective::Close) => {
                        if session.close(None).await.is_err() {
                            log_error_client_closed();
                        };

                        return;
                    },
                    Err(e) => {
                        tracing::error!("`WsSession` dropped before actix session: {e}");
                        break;
                    }
                }
            }

            msg = msg_stream.recv() => {
                last_modified_timestamp.store(Utc::now().timestamp(), Ordering::Relaxed);

                match msg {
                    Some(Ok(Message::Text(s))) => {
                        match s.deref() {
                            "myid" => {
                                tracing::info!(r#"Received message "myid", session={id}"#);
                                if session.text(&id.to_string()).await.is_err() {
                                    log_error_client_closed();
                                    break;
                                };
                                continue;
                            }
                            "close" => {
                                tracing::info!(r#"Received message "close", session={id}"#);
                                break;
                            }
                            _ => {
                                // message format:
                                // | type | <space> | command |
                                let Some((t, cmd)) = s.split_once(' ') else {
                                    tracing::error!(
                                        "Received message in wrong format: {s}, session={id}"
                                    );
                                    continue;
                                };

                                if let Err(e) =
                                    mq_producer.send_object(&(id, cmd.to_owned()), Some(t)).await
                                {
                                    tracing::error!("Websocket mq error: {e}");
                                }
                            }
                        }
                    }
                    // illegal message, stop websocket
                    Some(Ok(_)) => break,
                    Some(Err(e)) => {
                        tracing::error!("Websocket error: {e}");
                        break;
                    },
                    None => {
                        log_error_client_closed();
                        break;
                    }
                }
            }

            else => break,
        }
    }

    if session.close(None).await.is_err() {
        log_error_client_closed();
    };

    if let Err(e) = close_informer.send(WsServerOperateCommand::RemoveSession { id }) {
        tracing::error!("Close informer error: {e}");
    };
}

#[inline]
fn log_error_client_closed() {
    tracing::error!("Client closed session unilaterally");
}
