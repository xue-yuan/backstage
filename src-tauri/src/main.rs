// Backstage Mac app: a native window around the existing local server.
//
// On launch it starts the bundled Python server (app.py) on a fixed local port, waits until it
// answers, then points the window at it. Python is a uv-managed interpreter located with
// `uv python find`; it is started directly (not via `uv run`) so quitting the app can stop it. The server stops when the app quits (and on its own if
// the app ever dies, via --exit-with-parent). The port is fixed so the page's saved settings
// (localStorage is per origin) survive restarts.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

mod locale_zh;

const PORT: u16 = 47615;
// GUI apps get a minimal PATH, so look for uv where its installers put it.
const UV_PATHS: [&str; 2] = ["/opt/homebrew/bin/uv", "/usr/local/bin/uv"];
const UV_HOME_PATHS: [&str; 2] = [".local/bin/uv", ".cargo/bin/uv"];
const PYTHON_REQUEST: &str = ">=3.12";

struct Server(Mutex<Option<Child>>);

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn data_dir() -> PathBuf {
    home().join("Library/Application Support/Backstage")
}

/// The app used to be called "Crate Desk": move its data folder over once.
fn migrate_old_data_dir() {
    let old = home().join("Library/Application Support/Crate Desk");
    let new = data_dir();
    if !new.exists() && old.is_dir() {
        let _ = std::fs::rename(&old, &new);
    }
}

/// Append a line to app.log in the data folder (the window side; the server writes server.log).
fn app_log(message: &str) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(data_dir().join("app.log")) {
        let _ = writeln!(f, "{secs} {message}");
    }
}

/// The language chosen in the page; the server stores it in settings.json. English unless "zh".
fn lang_is_zh() -> bool {
    let Ok(text) = std::fs::read_to_string(data_dir().join("settings.json")) else {
        return false;
    };
    let Some(i) = text.find("\"lang\"") else {
        return false;
    };
    text[i + 6..].trim_start().trim_start_matches(':').trim_start().starts_with("\"zh\"")
}

/// The English message or its Chinese translation (locale_zh.rs), with {name} placeholders filled in.
fn tr(en: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    let template = if lang_is_zh() {
        locale_zh::ZH.iter().find(|(k, _)| *k == en).map(|(_, v)| *v).unwrap_or(en)
    } else {
        en
    };
    let mut out = template.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), &value.to_string());
    }
    out
}

fn port_open() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok()
}

fn find_uv() -> Option<PathBuf> {
    let home = home();
    UV_PATHS
        .iter()
        .map(PathBuf::from)
        .chain(UV_HOME_PATHS.iter().map(|p| home.join(p)))
        .find(|p| p.is_file())
}

/// A uv-managed Python interpreter (never the system one).
fn find_python() -> Result<PathBuf, String> {
    let uv = find_uv().ok_or_else(|| tr("uv was not found. Install uv first (for example: brew install uv).", &[]))?;
    let out = Command::new(&uv)
        .args(["python", "find", "--no-project", "--managed-python", PYTHON_REQUEST])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| tr("Could not run {program}: {error}", &[("program", &uv.display()), ("error", &e)]))?;
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    if !out.status.success() || !path.is_file() {
        return Err(tr(
            "uv found no Python matching {request}.\nRun this in Terminal: uv python install 3.14\n\n{details}",
            &[("request", &PYTHON_REQUEST), ("details", &String::from_utf8_lossy(&out.stderr).trim())],
        ));
    }
    Ok(path)
}

fn start_server(server_dir: &Path, data_dir: &Path) -> Result<Child, String> {
    if port_open() {
        return Err(tr("127.0.0.1:{port} is already in use (maybe another Backstage is still open).\nQuit it, then open Backstage again.", &[("port", &PORT)]));
    }
    let python = find_python()?;
    app_log(&format!("python: {}", python.display()));
    std::fs::create_dir_all(data_dir).map_err(|e| tr("Could not create the folder {path}: {error}", &[("path", &data_dir.display()), ("error", &e)]))?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("server.log"))
        .map_err(|e| tr("Could not write server.log: {error}", &[("error", &e)]))?;
    Command::new(&python)
        .arg("-B") // never write __pycache__ into the app bundle
        .arg(server_dir.join("app.py"))
        .args(["--port", &PORT.to_string(), "--no-browser", "--exit-with-parent", "--data-dir"])
        .arg(data_dir)
        .current_dir(server_dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .spawn()
        .map_err(|e| tr("Could not start {program}: {error}", &[("program", &python.display()), ("error", &e)]))
}

fn show_error(window: &WebviewWindow, message: &str) {
    let js = format!("showError({})", serde_json_string(message));
    let _ = window.eval(js);
}

// Minimal JSON string escaping for passing a message into the loading page.
fn serde_json_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    let app = tauri::Builder::default()
        .setup(|app| {
            migrate_old_data_dir();
            let data_dir = data_dir();
            let _ = std::fs::create_dir_all(&data_dir);
            // Navigate to the server only after the bundled loading page has finished loading;
            // navigating earlier can be overridden by that first load.
            let loading_done = Arc::new(AtomicBool::new(false));
            let loading_flag = loading_done.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Backstage")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 640.0)
                // Let the page's own drag & drop work (moving crates in the Crates view); Tauri's native
                // file-drop handler would otherwise swallow the drop events.
                .disable_drag_drop_handler()
                .on_page_load(move |window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        app_log(&format!("page loaded: {}", payload.url()));
                        if payload.url().scheme() != "http" {
                            let _ = window.eval(format!("setStatus({})", serde_json_string(&tr("Starting…", &[]))));
                            loading_flag.store(true, Ordering::SeqCst);
                        }
                    }
                })
                // Plan exports (JSON / Markdown) download into ~/Downloads.
                .on_download(|webview, event| {
                    if let DownloadEvent::Finished { path: Some(path), success: true, .. } = event {
                        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                        let msg = serde_json_string(&tr("Saved to Downloads: {name}", &[("name", &name)]));
                        let _ = webview.eval(format!("window.__crateDesk?.toast?.({msg})"));
                    }
                    true
                })
                .build()?;

            let server_dir = app.path().resource_dir()?.join("server");
            app_log(&format!("starting server from {}", server_dir.display()));
            match start_server(&server_dir, &data_dir) {
                Ok(child) => {
                    app.manage(Server(Mutex::new(Some(child))));
                    thread::spawn(move || {
                        let started = Instant::now();
                        while !(port_open() && loading_done.load(Ordering::SeqCst)) {
                            if started.elapsed() > Duration::from_secs(20) {
                                app_log("timed out waiting for the server / loading page");
                                let log = data_dir.join("server.log");
                                show_error(&window, &tr("The local server did not start within 20 seconds.\nDetails are in {path}", &[("path", &log.display())]));
                                return;
                            }
                            thread::sleep(Duration::from_millis(100));
                        }
                        let url = Url::parse(&format!("http://127.0.0.1:{PORT}/")).expect("valid url");
                        app_log(&format!("server ready after {:?}, navigating", started.elapsed()));
                        if let Err(e) = window.navigate(url) {
                            app_log(&format!("navigate failed: {e}"));
                            show_error(&window, &tr("Could not open the page: {error}", &[("error", &e)]));
                        }
                    });
                }
                Err(message) => {
                    app_log(&format!("server did not start: {message}"));
                    app.manage(Server(Mutex::new(None)));
                    let w = window.clone();
                    // Wait a moment so the loading page has defined showError().
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(400));
                        show_error(&w, &message);
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Backstage");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(server) = handle.try_state::<Server>() {
                if let Some(mut child) = server.0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
