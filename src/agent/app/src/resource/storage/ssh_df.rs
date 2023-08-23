pub async fn total(username_host: &str, port: &str) -> anyhow::Result<u64> {
    let s = get_string(username_host, port).await?;

    let available = s
        .split_whitespace()
        .nth(3)
        .ok_or(anyhow::anyhow!("available space is empty"))?
        .parse::<u64>()?;
    let used = get_used(&s)?;
    Ok(available + used)
}

#[tokio::test]
async fn sad() {
    let x = r#"Filesystem         1B-blocks        Used    Available Use% Mounted on
/abc/abc       123456 56789 999999   5% /
"#;
    let x = x.lines().nth(1).ok_or(anyhow::anyhow!("df output is empty")).unwrap();
    let available = x
        .split_whitespace()
        .nth(3)
        .ok_or(anyhow::anyhow!("available space is empty"))
        .unwrap()
        .parse::<u64>()
        .unwrap();
    let used = get_used(x).unwrap();
    assert_eq!(1056788, used + available);
}

pub async fn used(username_host: &str, port: &str) -> anyhow::Result<u64> {
    let s = get_string(username_host, port).await?;
    get_used(&s)
}

async fn get_string(username_host: &str, port: &str) -> anyhow::Result<String> {
    let out = tokio::process::Command::new("ssh")
        .args(["-p", port, username_host])
        .args(["df", "-B1", "."])
        .kill_on_drop(true)
        .output()
        .await?
        .stdout;
    let s = String::from_utf8_lossy(&out);
    let x = s.lines().nth(1).ok_or(anyhow::anyhow!("df output is empty"))?;
    Ok(x.to_owned())
}

fn get_used(s: &str) -> anyhow::Result<u64> {
    let used = s
        .split_whitespace()
        .nth(2)
        .ok_or(anyhow::anyhow!("available space is empty"))?
        .parse::<u64>()?;
    Ok(used)
}
