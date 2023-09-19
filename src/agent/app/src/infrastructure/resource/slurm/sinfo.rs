use std::ops::Add;

use anyhow::Context;
use serde::{Deserialize, Deserializer};

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Info<Node> {
    nodes: Vec<Node>,
}

#[derive(Debug, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub struct NodeTotal {
    #[serde(deserialize_with = "self::deserialize_memory")]
    pub memory: u64,
    pub cpus: usize,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct NodeAlloc {
    alloc_memory: u64,
    alloc_cpus: usize,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
struct CsvNodeAlloc {
    /// Total memory (unit: MiB)
    memory: u64,
    /// Free memory (unit: MiB)
    free_mem: u64,
    #[serde(rename = "CPUS(A/I/O/T)")]
    cpus: String,
}

#[derive(Debug, Default)]
pub struct NodeAllocSum {
    pub alloc_memory: u64,
    pub alloc_cpus: usize,
    pub alloc_nodes: usize,
}

impl<Node> Info<Node> {
    #[inline]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
}

impl Info<NodeTotal> {
    pub const ARGS: &[&'static str] = &["-o", "'%n %m %c'"];

    pub fn new(s: &[u8]) -> anyhow::Result<Self> {
        let mut reader = csv::ReaderBuilder::new().delimiter(b' ').from_reader(s);
        Ok(Self {
            nodes: reader.deserialize().collect::<Result<Vec<NodeTotal>, _>>()?,
        })
    }

    #[inline]
    pub fn total(&self) -> NodeTotal {
        self.nodes.iter().fold(NodeTotal::default(), |acc, n| acc + n)
    }
}

impl Info<NodeAlloc> {
    pub const ARGS: &[&'static str] = &["-o", "'%n %m %e %C'"];

    #[inline]
    pub fn new(s: &[u8]) -> anyhow::Result<Self> {
        let mut reader = csv::ReaderBuilder::new().delimiter(b' ').from_reader(s);
        Ok(Self {
            nodes: reader
                .deserialize()
                .map(|record| {
                    let node: CsvNodeAlloc = record?;
                    Ok(NodeAlloc {
                        alloc_memory: (node.memory - node.free_mem) * 1024 * 1024,
                        alloc_cpus: node
                            .cpus
                            .split_once('/')
                            .and_then(|(a, _)| a.parse::<usize>().ok())
                            .context("Failed to parse CPUS(A)")?,
                    })
                })
                .collect::<anyhow::Result<Vec<NodeAlloc>>>()?,
        })
    }

    #[inline]
    pub fn alloc(&self) -> NodeAllocSum {
        self.nodes.iter().fold(NodeAllocSum::default(), |acc, n| acc + n)
    }
}

impl Add<&Self> for NodeTotal {
    type Output = Self;

    fn add(mut self, rhs: &Self) -> Self::Output {
        self.cpus += rhs.cpus;
        self.memory += rhs.memory;
        self
    }
}

impl Add<&NodeAlloc> for NodeAllocSum {
    type Output = Self;

    fn add(mut self, rhs: &NodeAlloc) -> Self::Output {
        self.alloc_memory += rhs.alloc_memory;
        self.alloc_cpus += rhs.alloc_cpus;
        if rhs.alloc_cpus > 0 {
            self.alloc_nodes += 1;
        }
        self
    }
}

#[inline]
fn deserialize_memory<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    u64::deserialize(deserializer).map(|mem_mib| mem_mib * 1024 * 1024)
}

#[cfg(test)]
mod tests {
    use super::{Info, NodeAlloc, NodeTotal};
    use indoc::indoc;

    #[test]
    fn test_info_total() {
        let s = indoc! {"
            HOSTNAMES MEMORY CPUS
            foo0042 190000 8
            foo1145 200000 16
            foo1919 210000 32
            foo2023 200000 64
            foo5514 150000 128
        "};
        let info = Info::<NodeTotal>::new(s.as_bytes()).unwrap();
        assert_eq!(
            info,
            Info {
                nodes: vec![
                    NodeTotal {
                        memory: 199229440000,
                        cpus: 8
                    },
                    NodeTotal {
                        memory: 209715200000,
                        cpus: 16
                    },
                    NodeTotal {
                        memory: 220200960000,
                        cpus: 32
                    },
                    NodeTotal {
                        memory: 209715200000,
                        cpus: 64
                    },
                    NodeTotal {
                        memory: 157286400000,
                        cpus: 128
                    }
                ]
            }
        );
    }

    #[test]
    fn test_info_alloc() {
        let s = indoc! {"
            HOSTNAMES MEMORY FREE_MEM CPUS(A/I/O/T)
            foo0042 190000 184421 8/48/0/56
            foo1145 190000 184420 0/56/0/56
            foo1919 190000 184237 0/56/0/56
            foo2023 190000 184318 0/56/0/56
            foo5514 190000 183838 0/56/0/56
        "};
        let info = Info::<NodeAlloc>::new(s.as_bytes()).unwrap();
        assert_eq!(
            info,
            Info {
                nodes: vec![
                    NodeAlloc {
                        alloc_memory: 5850005504,
                        alloc_cpus: 8,
                    },
                    NodeAlloc {
                        alloc_memory: 5851054080,
                        alloc_cpus: 0,
                    },
                    NodeAlloc {
                        alloc_memory: 6042943488,
                        alloc_cpus: 0,
                    },
                    NodeAlloc {
                        alloc_memory: 5958008832,
                        alloc_cpus: 0,
                    },
                    NodeAlloc {
                        alloc_memory: 6461325312,
                        alloc_cpus: 0,
                    },
                ]
            }
        );
    }
}
