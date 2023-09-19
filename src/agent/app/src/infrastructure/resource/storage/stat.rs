use anyhow::{bail, Context};
use rustix::path::Arg;

use crate::infrastructure::ssh_proxy::SshProxy;

pub async fn total(proxy: &SshProxy) -> anyhow::Result<u64> {
    let output = proxy
        .command("stat")
        .args(["-f", "-c", "'%S %b'", "."])
        .output()
        .await
        .context("stat")?;
    if !output.status.success() {
        bail!(
            "`stat` terminated with an exception. Exit status: {}",
            output.status
        );
    }
    parse_total_storage(&output.stdout.to_string_lossy())
        .context("The format of `stat` result is wrong")
}

pub async fn used(proxy: &SshProxy) -> anyhow::Result<u64> {
    let output = proxy
        .command("stat")
        .args(["-f", "-c", "'%S %b %f'", "."])
        .output()
        .await
        .context("stat")?;
    if !output.status.success() {
        bail!(
            "`stat` terminated with an exception. Exit status: {}",
            output.status
        );
    }
    parse_used_storage(&output.stdout.to_string_lossy())
        .context("The format of `stat` result is wrong")
}

fn parse_total_storage(s: &str) -> Option<u64> {
    let (frsize, blocks) = s.trim_end().split_once(' ')?;
    Some(frsize.parse::<u64>().ok()? * blocks.parse::<u64>().ok()?)
}

fn parse_used_storage(s: &str) -> Option<u64> {
    let (frsize, blocks, bfree) = s.trim_end().split_once(' ').and_then(|(frsize, s)| {
        let (blocks, bfree) = s.split_once(' ')?;
        Some((frsize, blocks, bfree))
    })?;
    Some(frsize.parse::<u64>().ok()? * (blocks.parse::<u64>().ok()? - bfree.parse::<u64>().ok()?))
}

#[cfg(test)]
mod tests {
    use super::{parse_total_storage, parse_used_storage};

    #[test]
    fn test_parse_total() {
        assert_eq!(parse_total_storage("4096 114010190\n"), Some(466985738240));
    }

    #[test]
    fn test_parse_used() {
        assert_eq!(
            parse_used_storage("4096 114010190 51605000\n"),
            Some(255611658240)
        );
    }
}
