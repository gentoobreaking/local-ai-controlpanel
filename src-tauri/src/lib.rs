//! 薄 Rust commands（spec §45.2/§45.3）：
//! 只提供 clipboard / window / open-external-link + Control Plane 自動啟動/附著（§45.6 UI-6），
//! 不碰 filesystem / shell / secrets —— 那些一律在 Control Plane 層。
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// Control Plane 偵測/附著埠（設定化：ACP_CP_PORT，缺省 3001）。
fn cp_port() -> u16 {
    std::env::var("ACP_CP_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(3001)
}

/// Control Plane 是否已在 127.0.0.1:<port> 監聽（附著模式）。
fn cp_alive(port: u16) -> bool {
    let addr = format!("127.0.0.1:{port}")
        .to_socket_addrs()
        .ok()
        .and_then(|mut it| it.next());
    let Some(addr) = addr else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

/// 找 node 執行檔（設定化：ACP_CP_NODE，缺省 PATH 的 node）。
fn node_bin() -> String {
    std::env::var("ACP_CP_NODE").unwrap_or_else(|_| "node".to_string())
}

/// spawn 用的 Control Plane 入口（設定化：ACP_CP_PATH；缺省 resource_dir/control-plane/dist/main.js）。
fn cp_entry(resource_dir: &std::path::Path) -> PathBuf {
    if let Ok(p) = std::env::var("ACP_CP_PATH") {
        return PathBuf::from(p);
    }
    resource_dir.join("control-plane").join("dist").join("main.js")
}

/// 啟動 Control Plane（§45.6）：偵測 127.0.0.1:<port> 已存在 → 附著；
/// 不存在 → spawn `node <entry>`。spawn 失敗不視為致命（前端仍會嘗試連線並顯示重連）。
fn spawn_control_plane(app: &tauri::AppHandle) -> Option<Child> {
    // 設定化：ACP_CP_AUTOSTART=0 停用 spawn（外部管理 Control Plane）
    if std::env::var("ACP_CP_AUTOSTART").as_deref() == Ok("0") {
        return None;
    }
    let port = cp_port();
    if cp_alive(port) {
        // 附著：已存在，直接 return（前端 EventSource 會連上）
        return None;
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let entry = cp_entry(&resource_dir);
    if !entry.exists() {
        eprintln!("[acp-desktop] control-plane entry not found: {}", entry.display());
        return None;
    }

    let policies_dir = resource_dir.join("policies");
    let data_dir = std::env::var("ACP_CP_DATA_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        format!("{home}/.acp-data")
    });

    let mut cmd = Command::new(node_bin());
    cmd.arg(&entry)
        .env("CP_PORT", port.to_string())
        .env("CP_HOST", "127.0.0.1")
        .env("CP_DATA_DIR", &data_dir);
    if policies_dir.exists() {
        cmd.env("CP_POLICIES_DIR", &policies_dir);
    }
    let seatbelt_profile = resource_dir.join("sandbox-profiles").join("verification-default.sb");
    if seatbelt_profile.exists() {
        cmd.env("CP_SEATBELT_PROFILE", &seatbelt_profile);
    }
    // dev 模式（resource_dir 沒有 control-plane）→ 退到 monorepo 的 apps/control-plane
    if !entry.starts_with(&resource_dir) {
        // ACP_CP_PATH 已指向別處；沿用其自身 policies（不覆寫）
    }

    match cmd.spawn() {
        Ok(child) => {
            eprintln!(
                "[acp-desktop] spawned control-plane: node {} (port {port})",
                entry.display()
            );
            Some(child)
        }
        Err(e) => {
            eprintln!("[acp-desktop] failed to spawn control-plane: {e}");
            None
        }
    }
}
/// 開啟外部連結（例如 evidence 的 source URI）於系統瀏覽器。
/// 僅允許 http/https scheme；由 capabilities `opener:allow-open-url` 管制。
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
  if !url.starts_with("http://") && !url.starts_with("https://") {
    return Err("只允許 http/https".into());
  }
  app.opener().open_url(url, None::<String>).map_err(|e| e.to_string())
}

/// 設定視窗大小（供前端 zoom 呼叫）。
#[tauri::command]
fn set_window_size(app: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("main") {
    window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
      .map_err(|e| e.to_string())
  } else {
    Err("找不到主視窗".into())
  }
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_external, set_window_size])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Agent Control Plane");
            }
            // §45.6：spawn / 附著 Control Plane（child 由 OS 接管，drop handle 不 kill）
            let _ = spawn_control_plane(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
