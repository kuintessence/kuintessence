#!/bin/bash
rustup target add x86_64-unknown-linux-musl
rustup component add rustfmt
cargo build --release --bin agent --target=x86_64-unknown-linux-musl
mkdir -p tmp/agent
cp target/x86_64-unknown-linux-musl/release/agent tmp/agent
cp config/agent-config.yaml tmp/agent/config.yaml
mkdir -p tmp/agent/log
mkdir -p tmp/agent/data
mkdir -p tmp/agent/tasks
mkdir -p tmp/agent/bin
echo """[Unit]
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
WantedBy=default.target""" > tmp/agent/agent.service
echo """#!/bin/bash
chmod +x agent
tmux kill-session -t agent_session
tmux new-session -d -s agent_session './agent'""" > tmp/agent/run-with-tumx.sh
echo """#!/bin/bash
chmod +x agent
screen -S 'agent_session' -X stuff '^C'
screen -XS 'agent_session' quit
screen -wipe
screen -dmS 'agent_session'
screen -S 'agent_session' -X stuff './agent'""" > tmp/agent/run-with-screen.sh
cd tmp
zip -r9m agent agent
mv agent.zip ..
cd ..
rm -rf tmp
