use alice_architecture::hosting::IBackgroundService;
use domain::{command::SoftwareDeploymentCommand, service::DeploySoftwareService, sender::ISoftwareDeploymentSender, model::entity::task::TaskStatus};
use uuid::Uuid;
use std::{collections::HashMap, sync::Arc};
use tokio::task::JoinHandle;
use tracing::Instrument;

pub struct SoftwareDeploymentRunner {
    receiver: flume::Receiver<SoftwareDeploymentCommand>,
    service: Arc<dyn DeploySoftwareService>,
}

#[async_trait::async_trait]
impl IBackgroundService for SoftwareDeploymentRunner {
    async fn run(&self) {
        let mut spawns = HashMap::<Uuid, JoinHandle<()>>::new();
        loop {
            let service = self.service.clone();
            match self.receiver.recv_async().await {
                Ok(command) => match &command.task_status {
                    TaskStatus::Running => {
                        let spawn = tokio::spawn(
                            async move {
                                let service = service.clone();
                                match service.run_sub_task(command.id.to_string().as_str()).await {
                                    Ok(()) => {}
                                    Err(e) => log::error!("{}", e),
                                }
                            }
                            .instrument(tracing::trace_span!("software_deployment_runner")),
                        );
                        spawns.insert(command.id, spawn);
                    }
                    TaskStatus::Suspended => {
                        let spawn = spawns.get(&command.id);
                        if let Some(x) = spawn {
                            x.abort()
                        }
                    }
                    TaskStatus::Completing => {
                        spawns.remove(&command.id);
                        match service.complete_sub_task(command.id.to_string().as_str()).await {
                            Ok(()) => {}
                            Err(e) => log::error!("{}", e),
                        }
                    }
                    TaskStatus::Failed => {
                        spawns.remove(&command.id);
                        match service.fail_sub_task(command.id.to_string().as_str()).await {
                            Ok(()) => {}
                            Err(e) => log::error!("{}", e),
                        }
                    }
                    _ => unreachable!(),
                },
                Err(e) => log::error!("{}", e),
            }
        }
    }
}

impl SoftwareDeploymentRunner {
    pub fn new(
        receiver: flume::Receiver<SoftwareDeploymentCommand>,
        service: Arc<dyn DeploySoftwareService>,
    ) -> Self {
        Self { receiver, service }
    }
}

pub struct SoftwareDeploymentSender {
    receiver: flume::Receiver<SoftwareDeploymentCommand>,
    sender: Arc<flume::Sender<SoftwareDeploymentCommand>>,
}

#[async_trait::async_trait]
impl ISoftwareDeploymentSender for SoftwareDeploymentSender {
    async fn send(&self, command: SoftwareDeploymentCommand) -> anyhow::Result<()> {
        Ok(self.sender.send_async(command).await?)
    }
}

impl SoftwareDeploymentSender {
    pub fn new() -> Self {
        let (sender, receiver): (
            flume::Sender<SoftwareDeploymentCommand>,
            flume::Receiver<SoftwareDeploymentCommand>,
        ) = flume::unbounded();
        Self {
            sender: Arc::from(sender),
            receiver,
        }
    }

    pub fn get_receiver(&self) -> flume::Receiver<SoftwareDeploymentCommand> {
        self.receiver.clone()
    }
}
