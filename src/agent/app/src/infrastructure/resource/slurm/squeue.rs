use std::str::FromStr;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Status {
    jobs: Vec<Job>,
}

#[derive(Debug, Deserialize)]
pub struct Job {
    job_state: JobState,
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
pub enum JobState {
    #[serde(rename = "PENDING", alias = "SUSPENDED")]
    Queued,
    #[serde(rename = "RUNNING")]
    Running,
    #[serde(other)]
    Other,
}

impl Status {
    pub const ARGS: &[&'static str] = &[
        "-h",
        "-t",
        "'pending,running,suspended'",
        "-r",
        "-o",
        "'%T'",
    ];

    #[inline]
    pub fn new(s: &[u8]) -> Self {
        String::from_utf8_lossy(s).parse().unwrap()
    }

    /// get the count of queued and running jobs separately: `(queueds, runnings)`
    pub fn qr_count(&self) -> (usize, usize) {
        self.jobs.iter().fold((0, 0), |(mut queued, mut running), j| {
            match j.job_state {
                JobState::Queued => queued += 1,
                JobState::Running => running += 1,
                JobState::Other => (),
            }

            (queued, running)
        })
    }
}

impl FromStr for Status {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let jobs = s
            .trim_end()
            .split('\n')
            .map(|s| Job {
                job_state: s.parse().unwrap(),
            })
            .collect();
        Ok(Self { jobs })
    }
}

impl FromStr for JobState {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "PENDING" | "SUSPENDED" => Self::Queued,
            "RUNNING" => Self::Running,
            _ => Self::Other,
        })
    }
}
