use std::future::Future;
use std::io;
use std::io::{stdout, Write};
use std::pin::Pin;
use std::task::{ready, Poll};
use std::time::Duration;

use crossterm::cursor::Show;
use crossterm::execute;
use crossterm::{
    cursor::{Hide, RestorePosition, SavePosition},
    queue,
    style::Print,
    terminal::{Clear, ClearType},
};
use tokio::time::Instant;
use tokio::time::{sleep, Sleep};

const UNIT_SECOND: Duration = Duration::from_secs(1);

#[derive(Debug)]
pub struct Counter {
    count: u64,
    sleep: Pin<Box<Sleep>>,
}

impl Counter {
    #[inline]
    pub fn new(count: u64) -> Self {
        Self {
            count,
            sleep: Box::pin(sleep(UNIT_SECOND)),
        }
    }

    pub fn render(&self) -> io::Result<()> {
        queue!(
            stdout(),
            SavePosition,
            Hide,
            Clear(ClearType::CurrentLine),
            Print(format!("Time for verifying: {}", self.count)),
            RestorePosition
        )?;
        io::stdout().flush()
    }
}

impl Future for Counter {
    type Output = io::Result<()>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
        ready!(self.sleep.as_mut().poll(cx));

        self.count -= 1;

        if let e @ Err(_) = self.render() {
            return Poll::Ready(e);
        }

        if self.count == 0 {
            return Poll::Ready(Ok(()));
        }

        self.sleep.as_mut().reset(Instant::now() + UNIT_SECOND);
        Poll::Pending
    }
}

impl Drop for Counter {
    fn drop(&mut self) {
        let _ = execute!(stdout(), Show);
    }
}
