//! 薄 Rust commands（spec §45.2/§45.3）：
//! 只提供 clipboard / window / open-external-link，
//! 不碰 filesystem / shell / secrets —— 那些一律在 Control Plane 層。

use tauri::{Manager, Url};
use tauri_plugin_opener::OpenerExt;

/// 開啟外部連結（例如 evidence 的 source URI）於系統瀏覽器。
/// 僅允許 http/https scheme；由 capabilities `opener:allow-open-url` 管制。
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|e| e.to_string())?;
    match parsed.scheme() {
        "https" | "http" => app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string()),
        _ => Err(format!("scheme not allowed: {}", parsed.scheme())),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_external])
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("Agent Control Plane");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
