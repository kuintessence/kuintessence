use std::ops::Add;
use std::str::FromStr;

use serde::Deserialize;

use super::MissingFieldError;

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct Info<Node> {
    nodes: Vec<Node>,
}

#[derive(Debug, Deserialize, Default, PartialEq, Eq)]
pub struct NodeTotal {
    pub real_memory: u64,
    pub cpus: usize,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct NodeAlloc {
    alloc_memory: u64,
    alloc_cpus: usize,
    using: bool,
}

#[derive(Debug, Default)]
pub struct NodeAllocSum {
    pub alloc_memory: u64,
    pub alloc_cpus: usize,
    pub alloc_nodes: usize,
}

impl<Node> Info<Node> {
    #[inline]
    pub fn new(s: &[u8]) -> anyhow::Result<Self>
    where
        Node: FromStr<Err = anyhow::Error>,
    {
        String::from_utf8_lossy(s).parse()
    }

    #[inline]
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
}

impl Info<NodeTotal> {
    #[inline]
    pub const fn args() -> &'static [&'static str] {
        &["sinfo", "-h", "-o", "'%n %m %c'"]
    }

    #[inline]
    pub fn total(&self) -> NodeTotal {
        self.nodes.iter().fold(NodeTotal::default(), |acc, n| acc + n)
    }
}

impl Info<NodeAlloc> {
    #[inline]
    pub const fn args() -> &'static [&'static str] {
        &["sinfo", "-h", "-o", "'%n %m %e %C'"]
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
        self.real_memory += rhs.real_memory;
        self
    }
}

impl Add<&NodeAlloc> for NodeAllocSum {
    type Output = Self;

    fn add(mut self, rhs: &NodeAlloc) -> Self::Output {
        self.alloc_memory += rhs.alloc_memory;
        self.alloc_cpus += rhs.alloc_cpus;
        if rhs.using {
            self.alloc_nodes += 1;
        }
        self
    }
}

impl<Node> FromStr for Info<Node>
where
    Node: FromStr<Err = anyhow::Error>,
{
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let nodes = s.trim_end().split('\n').map(|line| line.parse()).collect::<Result<_, _>>()?;
        Ok(Self { nodes })
    }
}

impl FromStr for NodeTotal {
    type Err = anyhow::Error;

    // Parse example: foobar 190000 56
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut values = s.split(' ').skip(1);
        let real_memory: u64 = values.next().ok_or(MissingFieldError("real_memory"))?.parse()?;
        let cpus = values.next().ok_or(MissingFieldError("cpus"))?.parse()?;

        Ok(Self {
            real_memory: real_memory * 1024 * 1024,
            cpus,
        })
    }
}

impl FromStr for NodeAlloc {
    type Err = anyhow::Error;

    // Parse example: foobar 190000 184419 0/56/0/56
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut values = s.split(' ').skip(1);
        let real_memory: u64 = values.next().ok_or(MissingFieldError("real_memory"))?.parse()?;
        let free_memory: u64 = values.next().ok_or(MissingFieldError("free_memory"))?.parse()?;
        let alloc_cpus = values
            .next()
            .and_then(|c| c.split('/').next())
            .ok_or(MissingFieldError("cpus(A)"))?
            .parse()?;

        Ok(Self {
            alloc_memory: (real_memory - free_memory) * 1024 * 1024,
            alloc_cpus,
            using: alloc_cpus > 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Info, NodeAlloc, NodeTotal};
    use indoc::indoc;

    #[test]
    fn test_info_total() {
        let s = indoc! {"
            foobar 190000 8
            foobar 200000 16
            foobar 210000 32
            foobar 200000 64
            foobar 150000 128
        "};
        let info: Info<NodeTotal> = s.parse().unwrap();
        assert_eq!(
            info,
            Info {
                nodes: vec![
                    NodeTotal {
                        real_memory: 190000,
                        cpus: 8
                    },
                    NodeTotal {
                        real_memory: 200000,
                        cpus: 16
                    },
                    NodeTotal {
                        real_memory: 210000,
                        cpus: 32
                    },
                    NodeTotal {
                        real_memory: 200000,
                        cpus: 64
                    },
                    NodeTotal {
                        real_memory: 150000,
                        cpus: 128
                    }
                ]
            }
        );
    }

    #[test]
    fn test_info_alloc() {
        let s = indoc! {"
            foobar 190000 184420 0/56/0/56
            foobar 190000 184237 0/56/0/56
            foobar 190000 184421 8/48/0/56
            foobar 190000 184318 0/56/0/56
            foobar 190000 183838 0/56/0/56
        "};
        let info: Info<NodeAlloc> = s.parse().unwrap();
        assert_eq!(
            info,
            Info {
                nodes: vec![
                    NodeAlloc {
                        alloc_memory: 5580,
                        alloc_cpus: 0,
                        using: false,
                    },
                    NodeAlloc {
                        alloc_memory: 5763,
                        alloc_cpus: 0,
                        using: false,
                    },
                    NodeAlloc {
                        alloc_memory: 5579,
                        alloc_cpus: 8,
                        using: true,
                    },
                    NodeAlloc {
                        alloc_memory: 5682,
                        alloc_cpus: 0,
                        using: false,
                    },
                    NodeAlloc {
                        alloc_memory: 6162,
                        alloc_cpus: 0,
                        using: false,
                    },
                ]
            }
        );
    }
}
