// Backstage Mac app: a native window around the existing local server.
//
// On launch it starts the bundled Python server (app.py) on a fixed local port, waits until it
// answers, then points the window at it. Python is a uv-managed interpreter located with
// `uv python find`; it is started directly (not via `uv run`) so quitting the app can stop it. The server stops when the app quits (and on its own if
// the app ever dies, via --exit-with-parent). The port is fixed so the page's saved settings
// (localStorage is per origin) survive restarts.
//
// Also: a menu bar whose View menu runs page commands (⌘R reload, ⌘1–7 tabs), the window's size and
// position remembered between launches, and the Dock icon badged with the number of unapplied changes.
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

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::{DownloadEvent, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

mod locale_zh;

const PORT: u16 = 47615;
// The page's tabs in order (ids as in static/js/main.js); the View menu binds them to ⌘1–7.
const VIEWS: [(&str, &str); 7] = [
    ("home", "Overview"),
    ("folders", "Folders"),
    ("inbox", "Sort"),
    ("cleanup", "Cleanup"),
    ("structure", "Crates"),
    ("plan", "Plan"),
    ("guide", "Guide"),
];
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
const MIN_SIZE: (f64, f64) = (1024.0, 640.0);
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

// ---------- menu bar ----------

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let t = |s: &str| tr(s, &[]);
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Backstage",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&t("About Backstage")), None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, Some(&t("Services")))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some(&t("Hide Backstage")))?,
            &PredefinedMenuItem::hide_others(app, Some(&t("Hide Others")))?,
            &PredefinedMenuItem::show_all(app, Some(&t("Show All")))?,
            &sep()?,
            &PredefinedMenuItem::quit(app, Some(&t("Quit Backstage")))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        t("Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&t("Undo")))?,
            &PredefinedMenuItem::redo(app, Some(&t("Redo")))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some(&t("Cut")))?,
            &PredefinedMenuItem::copy(app, Some(&t("Copy")))?,
            &PredefinedMenuItem::paste(app, Some(&t("Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(&t("Select All")))?,
        ],
    )?;
    // Item ids are the page commands (window.__crateDesk.command in static/js/main.js).
    let view = Submenu::new(app, t("View"), true)?;
    view.append(&MenuItem::with_id(app, "reload", t("Reload Serato Snapshot"), true, Some("CmdOrCtrl+R"))?)?;
    view.append(&sep()?)?;
    for (i, (id, label)) in VIEWS.iter().enumerate() {
        view.append(&MenuItem::with_id(app, format!("view:{id}"), t(label), true, Some(format!("CmdOrCtrl+{}", i + 1)))?)?;
    }
    view.append(&sep()?)?;
    view.append(&PredefinedMenuItem::fullscreen(app, Some(&t("Enter Full Screen")))?)?;
    let window = Submenu::with_items(
        app,
        t("Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&t("Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(&t("Zoom")))?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, Some(&t("Close Window")))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window])
}

fn run_page_command(app: &AppHandle, id: &str) {
    if id != "reload" && !id.starts_with("view:") {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        // Before the page has loaded (the bundled loading page) there is no __crateDesk: nothing happens.
        let _ = window.eval(format!("window.__crateDesk?.command?.({})", serde_json_string(id)));
    }
}

// ---------- window size and position ----------

/// Logical size and outer position of the window when it was last normal (not zoomed / full screen).
#[derive(Clone, Copy, Default)]
struct Geometry {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    maximized: bool,
}

struct WindowGeometry(Arc<Mutex<Geometry>>);

fn geometry_path() -> PathBuf {
    data_dir().join("window-state.json")
}

fn load_geometry() -> Option<Geometry> {
    let text = std::fs::read_to_string(geometry_path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let num = |k: &str| v.get(k).and_then(|n| n.as_f64());
    Some(Geometry {
        width: num("width")?,
        height: num("height")?,
        x: num("x")?,
        y: num("y")?,
        maximized: v.get("maximized").and_then(|m| m.as_bool()).unwrap_or(false),
    })
}

fn save_geometry(g: &Geometry) {
    if g.width < MIN_SIZE.0 || g.height < MIN_SIZE.1 {
        return; // never recorded
    }
    let json = serde_json::json!({ "width": g.width, "height": g.height, "x": g.x, "y": g.y, "maximized": g.maximized });
    let _ = std::fs::write(geometry_path(), json.to_string());
}

/// The saved title bar still lies on a connected display (a monitor may have been unplugged).
fn on_screen(app: &AppHandle, g: &Geometry) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    let (px, py) = (g.x + 80.0, g.y + 12.0);
    monitors.iter().any(|m| {
        let s = m.scale_factor();
        let (mx, my) = (m.position().x as f64 / s, m.position().y as f64 / s);
        let (mw, mh) = (m.size().width as f64 / s, m.size().height as f64 / s);
        px >= mx && px < mx + mw && py >= my && py < my + mh
    })
}

fn remember_geometry(window: &WebviewWindow, geometry: &Mutex<Geometry>) {
    let (Ok(maximized), Ok(fullscreen), Ok(minimized)) = (window.is_maximized(), window.is_fullscreen(), window.is_minimized()) else {
        return;
    };
    if fullscreen || minimized {
        return;
    }
    let mut g = geometry.lock().unwrap();
    g.maximized = maximized;
    if maximized {
        return; // keep the size to return to
    }
    if let (Ok(scale), Ok(size), Ok(pos)) = (window.scale_factor(), window.inner_size(), window.outer_position()) {
        g.width = size.width as f64 / scale;
        g.height = size.height as f64 / scale;
        g.x = pos.x as f64 / scale;
        g.y = pos.y as f64 / scale;
    }
}

// ---------- Dock badge ----------

/// Number of unapplied changes in the plan (the count the Plan tab shows).
fn plan_change_count(path: &Path) -> Option<i64> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(v.get("changes")?.as_array()?.len() as i64)
}

/// Watch plan.json (the server rewrites it on every change) and badge the Dock icon with its count.
fn watch_plan_for_badge(window: WebviewWindow, plan: PathBuf) {
    thread::spawn(move || {
        let mut seen: Option<SystemTime> = None;
        let mut shown: i64 = -1;
        loop {
            let modified = std::fs::metadata(&plan).and_then(|m| m.modified()).ok();
            if modified != seen {
                let count = if modified.is_some() { plan_change_count(&plan) } else { Some(0) };
                if let Some(n) = count {
                    seen = modified;
                    if n != shown {
                        shown = n;
                        let _ = window.set_badge_count(if n > 0 { Some(n) } else { None });
                    }
                } // unreadable for a moment: try again on the next tick
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
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
        .menu(|handle| build_menu(handle))
        .on_menu_event(|handle, event| run_page_command(handle, event.id().as_ref()))
        .setup(|app| {
            migrate_old_data_dir();
            let data_dir = data_dir();
            let _ = std::fs::create_dir_all(&data_dir);
            // Navigate to the server only after the bundled loading page has finished loading;
            // navigating earlier can be overridden by that first load.
            let loading_done = Arc::new(AtomicBool::new(false));
            let loading_flag = loading_done.clone();
            let saved = load_geometry().filter(|g| g.width >= MIN_SIZE.0 && g.height >= MIN_SIZE.1);
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Backstage")
                .min_inner_size(MIN_SIZE.0, MIN_SIZE.1);
            builder = match saved {
                Some(g) => {
                    let b = builder.inner_size(g.width, g.height).maximized(g.maximized);
                    if on_screen(app.handle(), &g) { b.position(g.x, g.y) } else { b.center() }
                }
                None => builder.inner_size(DEFAULT_SIZE.0, DEFAULT_SIZE.1),
            };
            let window = builder
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

            let geometry = Arc::new(Mutex::new(saved.unwrap_or_default()));
            remember_geometry(&window, &geometry);
            {
                let (w, g) = (window.clone(), geometry.clone());
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Resized(_) | WindowEvent::Moved(_)) {
                        remember_geometry(&w, &g);
                    }
                });
            }
            app.manage(WindowGeometry(geometry));
            watch_plan_for_badge(window.clone(), data_dir.join("plan.json"));

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
            if let Some(geometry) = handle.try_state::<WindowGeometry>() {
                save_geometry(&geometry.0.lock().unwrap());
            }
            if let Some(server) = handle.try_state::<Server>() {
                if let Some(mut child) = server.0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    });
}
