use bytesize::ByteSize;
use serde::{de::DeserializeOwned, Deserialize};
use std::collections::HashMap;
use std::ops::Add;

#[derive(Debug, Deserialize)]
pub struct Status<Node> {
    nodes: HashMap<String, Node>,
}

/// node with available resources
#[derive(Debug, Deserialize)]
pub struct NodeAvailable {
    resources_available: Resources,
}

/// node with assigned resources
#[derive(Debug, Deserialize)]
pub struct NodeAssigned {
    resources_assigned: Resources,
    jobs: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct Resources {
    mem: Option<ByteSize>,
    ncpus: Option<usize>,
}

#[derive(Debug, Deserialize, Default)]
pub struct SumResources {
    pub mem: ByteSize,
    pub ncpus: usize,
}

impl<N> Status<N> {
    pub const ARGS: &[&'static str] = &["-a", "-F", "json"];

    #[inline]
    pub fn new(s: &[u8]) -> serde_json::Result<Self>
    where
        N: DeserializeOwned,
    {
        serde_json::from_slice(s)
    }

    #[inline]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
}

impl Status<NodeAvailable> {
    #[inline]
    pub fn available(&self) -> SumResources {
        self.nodes.values().fold(SumResources::default(), |acc, r| {
            acc + &r.resources_available
        })
    }
}

impl Status<NodeAssigned> {
    /// Return the assigned resources and count of using vnodes
    #[inline]
    pub fn assigned(&self) -> (SumResources, usize) {
        self.nodes.values().fold(Default::default(), |(res, nodes), r| {
            (
                res + &r.resources_assigned,
                nodes + r.jobs.as_ref().map(Vec::len).unwrap_or_default(),
            )
        })
    }
}

impl Add<&Resources> for SumResources {
    type Output = Self;

    #[inline]
    fn add(mut self, rhs: &Resources) -> Self::Output {
        self.mem += rhs.mem.unwrap_or_default();
        self.ncpus += rhs.ncpus.unwrap_or_default();
        self
    }
}
