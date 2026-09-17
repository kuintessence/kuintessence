// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

/// Holds the spawned `kq gui serve` child so it is dropped (and killed) on exit.
struct Sidecar(#[allow(dead_code)] CommandChild);

/// Pick an ephemeral free port by binding to :0 and reading back the assignment.
/// The listener is dropped immediately; the sidecar re-binds the same port. A
/// tiny race window exists but is acceptable for a single-user local desktop app.
fn free_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let port = free_port()?;
            let token = Uuid::new_v4().to_string();

            let child = app
                .shell()
                .sidecar("kq")?
                .args([
                    "gui",
                    "serve",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &port.to_string(),
                    "--token",
                    &token,
                ])
                .spawn()?
                .1;
            app.manage(Sidecar(child));

            let init_script = format!(
                "window.__KQ_LOCAL__ = {{ baseUrl: 'http://127.0.0.1:{port}/api', token: '{token}' }};"
            );
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kuintessence")
                .inner_size(1280.0, 800.0)
                .initialization_script(&init_script)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Kuintessence desktop shell");
}
