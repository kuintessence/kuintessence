rustup target add x86_64-unknown-linux-musl
rustup component add rustfmt
cargo build --release --bin agent --target=x86_64-unknown-linux-musl
New-Item -Path "tmp", "tmp/agent", "tmp/agent/log", "tmp/agent/data", "tmp/agent/tasks", "tmp/agent/bin" -ItemType Directory
Copy-Item target/x86_64-unknown-linux-musl/release/agent tmp/agent
Copy-Item config/agent-config.yaml tmp/agent/config.yaml
@"
[Unit]
Description=The COS Agent
DefaultDependencies=no
After=network.target nss-lookup.target

[Service]
Type=forking
User=agent
Group=agent
ExecStart=%h/agent/agent
KillSignal=SIGINT

[Install]
WantedBy=default.target
"@ | Out-File tmp/agent/agent.service -NoNewline -Encoding utf8NoBOM -Force
@"
#!/bin/bash
chmod +x agent
tmux kill-session -t agent_session
tmux new-session -d -s agent_session './agent'
"@ | Out-File tmp/agent/run-with-tumx.sh -NoNewline -Encoding utf8NoBOM -Force
@"
#!/bin/bash
chmod +x agent
screen -S "agent_session" -X stuff "^C";
screen -XS "agent_session" quit;
screen -wipe;
screen -dmS "agent_session";
screen -S "agent_session" -X stuff "./agent"
"@ | Out-File tmp/agent/run-with-screen.sh -NoNewline -Encoding utf8NoBOM -Force
Compress-Archive -DestinationPath agent.zip -Path "tmp/agent" -CompressionLevel Optimal
