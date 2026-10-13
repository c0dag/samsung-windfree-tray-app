// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ac;
mod cert;
mod discover;
mod icon;

use ac::{LocalAc, Status};
use serde_json::{json, Value as J};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

const CLIMATE: &[&str] = &["temp", "modo", "vento", "extra", "oscilar"];
const POLL_VISIBLE: Duration = Duration::from_secs(15);
const POLL_HIDDEN: Duration = Duration::from_secs(60);
const DEBOUNCE: Duration = Duration::from_millis(500);
const SETTLE: Duration = Duration::from_millis(900);
// A tray click steals focus on mouse-down, so the blur handler hides the panel just
// before the click itself arrives; a hide this recent means the click was a "close".
const BLUR_CLICK_WINDOW: Duration = Duration::from_millis(300);

enum Msg {
    Set(String, J),
    Refresh,
    Visible(bool),
    Choose(Device),
}

struct Shared {
    view: Mutex<J>,
    tx: Sender<Msg>,
    cert: (String, String),
    tray_rect: Mutex<Option<(i32, i32, i32, i32)>>,
    last_hide: Mutex<Option<Instant>>,
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    std::fs::create_dir_all(&dir).ok();
    dir
}

#[derive(Clone)]
struct Device {
    id: String,
    nome: String,
    ip: Option<String>,
}

fn load_device(dir: &PathBuf) -> Option<Device> {
    let raw = std::fs::read_to_string(dir.join("device.json")).ok()?;
    let v: J = serde_json::from_str(&raw).ok()?;
    Some(Device {
        id: v.get("id")?.as_str()?.to_string(),
        nome: v.get("nome").and_then(|n| n.as_str()).unwrap_or("Ar-condicionado").to_string(),
        ip: v.get("ip").and_then(|n| n.as_str()).map(String::from),
    })
}

fn save_device(dir: &PathBuf, d: &Device) {
    let v = json!({ "id": d.id, "nome": d.nome, "ip": d.ip });
    std::fs::write(dir.join("device.json"), serde_json::to_string_pretty(&v).unwrap_or_default()).ok();
}

struct Worker {
    app: AppHandle,
    dir: PathBuf,
    cert: (String, String),
    device: Option<Device>,
    ac: Option<LocalAc>,
    confirmed: Option<Status>,
    pending: BTreeMap<String, J>,
    inflight: BTreeMap<String, J>,
    error: Option<J>,
    updated_at: Option<u128>,
    source: &'static str,
    running: bool,
    visible: bool,
    last_set: Instant,
    last_poll: Instant,
}

impl Worker {
    fn new(app: AppHandle, dir: PathBuf, cert: (String, String)) -> Self {
        let device = load_device(&dir);
        Worker {
            app,
            dir,
            cert,
            device,
            ac: None,
            confirmed: None,
            pending: BTreeMap::new(),
            inflight: BTreeMap::new(),
            error: None,
            updated_at: None,
            source: "local",
            running: false,
            visible: false,
            last_set: Instant::now(),
            last_poll: Instant::now() - Duration::from_secs(120),
        }
    }

    fn will_be_on(&self) -> bool {
        match self.pending.get("ligado").or_else(|| self.inflight.get("ligado")) {
            Some(J::Bool(b)) => *b,
            _ => self.confirmed.as_ref().map(|c| c.ligado).unwrap_or(false),
        }
    }

    fn sendable(&self) -> BTreeMap<String, J> {
        let on = self.will_be_on();
        self.pending
            .iter()
            .filter(|(k, _)| on || !CLIMATE.contains(&k.as_str()))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    fn device_json(&self) -> J {
        let base = match &self.confirmed {
            Some(s) => serde_json::to_value(s).unwrap_or(J::Null),
            None => return J::Null,
        };
        let mut obj = base.as_object().cloned().unwrap_or_default();
        for (k, v) in self.inflight.iter().chain(self.pending.iter()) {
            obj.insert(k.clone(), v.clone());
        }
        J::Object(obj)
    }

    fn view(&self) -> J {
        let sendable = self.sendable();
        let held: Vec<String> = self.pending.keys().filter(|k| !sendable.contains_key(*k)).cloned().collect();
        json!({
            "device": self.device_json(),
            "setup": self.device.is_none(),
            "ip": self.device.as_ref().and_then(|d| d.ip.clone()),
            "syncing": self.running || !sendable.is_empty(),
            "held": held,
            "error": self.error,
            "updatedAt": self.updated_at,
            "source": self.source,
        })
    }

    fn emit(&self) {
        let view = self.view();
        if let Some(shared) = self.app.try_state::<Shared>() {
            *shared.view.lock().unwrap() = view.clone();
        }
        self.app.emit("state", &view).ok();
        self.update_tray();
    }

    fn update_tray(&self) {
        let (temp, on, modo) = match &self.confirmed {
            Some(s) => (s.temp, s.ligado, s.modo.clone()),
            None => (None, false, "cool".into()),
        };
        if let Some(tray) = self.app.tray_by_id("main") {
            tray.set_icon(Some(icon::tray_icon(temp, on, icon::tint_for(&modo, on)))).ok();
            let tip = match &self.confirmed {
                Some(s) => format!("{} {}", s.nome.clone().unwrap_or_default(), if on { format!("ligado em {} °C", temp.unwrap_or(0)) } else { "desligado".into() }),
                None => "WindFree".into(),
            };
            tray.set_tooltip(Some(tip)).ok();
        }
    }

    fn ensure_connected(&mut self) -> Result<(), String> {
        if self.ac.is_some() {
            return Ok(());
        }
        let dev = self.device.clone().ok_or("Nenhum ar-condicionado escolhido")?;
        if let Some(ip) = &dev.ip {
            if let Ok(mut ac) = LocalAc::connect(ip, &self.cert.0, &self.cert.1) {
                if ac.device_id().as_deref() == Some(&dev.id) {
                    self.ac = Some(ac);
                    return Ok(());
                }
            }
        }
        let ip = discover::resolve_ip(&dev.id, &self.cert.0, &self.cert.1).ok_or("Ar não encontrado na rede")?;
        self.ac = Some(LocalAc::connect(&ip, &self.cert.0, &self.cert.1).map_err(|_| "O ar não respondeu".to_string())?);
        let mut d = dev;
        d.ip = Some(ip);
        save_device(&self.dir, &d);
        self.device = Some(d);
        Ok(())
    }

    fn read_status(&mut self) -> Result<Status, String> {
        self.ensure_connected()?;
        let nome = self.device.as_ref().map(|d| d.nome.clone());
        let ac = self.ac.as_mut().unwrap();
        Ok(ac.get_status(nome))
    }

    fn run_refresh(&mut self) {
        if self.device.is_none() {
            self.last_poll = Instant::now();
            self.emit();
            return;
        }
        self.running = true;
        self.emit();
        match self.read_status() {
            Ok(s) => {
                self.confirmed = Some(s);
                self.updated_at = Some(now_ms());
                self.error = None;
            }
            Err(e) => {
                self.ac = None;
                self.error = Some(json!({ "kind": "failed", "message": e }));
            }
        }
        self.running = false;
        self.last_poll = Instant::now();
        self.emit();
    }

    fn flush(&mut self) {
        let changes = self.sendable();
        if changes.is_empty() {
            return;
        }
        for k in changes.keys() {
            self.pending.remove(k);
        }
        self.inflight = changes.clone();
        self.running = true;
        self.emit();

        let result = (|| -> Result<Status, String> {
            self.ensure_connected()?;
            let nome = self.device.as_ref().map(|d| d.nome.clone());
            let ac = self.ac.as_mut().unwrap();
            // power on first, power off last, so climate settings apply.
            let order = |k: &str, v: &J| -> i32 {
                if k == "ligado" {
                    if v.as_bool() == Some(true) { 0 } else { 2 }
                } else {
                    1
                }
            };
            let mut items: Vec<(&String, &J)> = changes.iter().collect();
            items.sort_by_key(|(k, v)| order(k, v));
            for (k, v) in items {
                let val = match v {
                    J::Bool(b) => b.to_string(),
                    J::Number(n) => n.to_string(),
                    J::String(s) => s.clone(),
                    _ => continue,
                };
                ac.set(k, &val)?;
            }
            std::thread::sleep(SETTLE);
            Ok(ac.get_status(nome))
        })();

        self.inflight.clear();
        self.running = false;
        match result {
            Ok(s) => {
                let pendente: Vec<String> = changes
                    .iter()
                    .filter(|(k, v)| {
                        let got = serde_json::to_value(&s).ok().and_then(|sv| sv.get(k.as_str()).cloned());
                        got.as_ref() != Some(*v)
                    })
                    .map(|(k, _)| k.clone())
                    .collect();
                self.confirmed = Some(s);
                self.updated_at = Some(now_ms());
                self.error = if pendente.is_empty() { None } else { Some(json!({ "kind": "unconfirmed", "keys": pendente })) };
            }
            Err(e) => {
                self.ac = None;
                self.error = Some(json!({ "kind": "failed", "message": e }));
            }
        }
        self.emit();
    }

    fn choose(&mut self, d: Device) {
        save_device(&self.dir, &d);
        self.device = Some(d);
        self.ac = None;
        self.confirmed = None;
        self.pending.clear();
        self.inflight.clear();
        self.error = None;
        self.run_refresh();
    }

    fn set(&mut self, key: String, value: J) {
        let same = self.confirmed.as_ref().and_then(|c| serde_json::to_value(c).ok()).and_then(|v| v.get(&key).cloned()) == Some(value.clone())
            && !self.inflight.contains_key(&key);
        if same {
            self.pending.remove(&key);
        } else {
            self.pending.insert(key, value);
        }
        self.error = None;
        self.last_set = Instant::now();
        self.emit();
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn worker_loop(mut w: Worker, rx: mpsc::Receiver<Msg>) {
    w.run_refresh();
    loop {
        let now = Instant::now();
        let debounce_due = if !w.sendable().is_empty() { w.last_set + DEBOUNCE } else { now + Duration::from_secs(3600) };
        let interval = if w.visible { POLL_VISIBLE } else { POLL_HIDDEN };
        let poll_due = w.last_poll + interval;
        let wake = debounce_due.min(poll_due);
        let timeout = wake.saturating_duration_since(now);
        match rx.recv_timeout(timeout) {
            Ok(Msg::Set(k, v)) => w.set(k, v),
            Ok(Msg::Refresh) => w.run_refresh(),
            Ok(Msg::Visible(b)) => w.visible = b,
            Ok(Msg::Choose(d)) => w.choose(d),
            Err(RecvTimeoutError::Timeout) => {
                if !w.sendable().is_empty() && Instant::now() >= w.last_set + DEBOUNCE {
                    w.flush();
                } else {
                    w.run_refresh();
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

// --- Tauri commands ---
#[tauri::command]
fn get_state(state: State<Shared>) -> J {
    json!({ "view": state.view.lock().unwrap().clone(), "darkTaskbar": true })
}

#[tauri::command]
fn ac_set(state: State<Shared>, key: String, value: J) {
    state.tx.send(Msg::Set(key, value)).ok();
}

#[tauri::command]
fn ac_refresh(state: State<Shared>) {
    state.tx.send(Msg::Refresh).ok();
}

fn found_json(f: &discover::Found) -> J {
    json!({ "ip": f.ip, "id": f.di, "ligado": f.status.ligado, "temp": f.status.temp, "ambiente": f.status.ambiente })
}

// Discovery blocks for a few seconds (LAN sweep plus a DTLS handshake per unit), so it
// runs off the main thread.
#[tauri::command]
async fn scan_devices(state: State<'_, Shared>) -> Result<J, String> {
    let (cert, key) = state.cert.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let scan = discover::scan(&cert, &key);
        json!({
            "network": scan.network,
            "responded": scan.responded,
            "found": scan.found.iter().map(found_json).collect::<Vec<_>>(),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn probe_ip(state: State<'_, Shared>, ip: String) -> Result<J, String> {
    let (cert, key) = state.cert.clone();
    tauri::async_runtime::spawn_blocking(move || discover::probe(ip.trim(), &cert, &key).map(|f| found_json(&f)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn choose_device(state: State<Shared>, id: String, ip: String, nome: String) {
    state.tx.send(Msg::Choose(Device { id, nome, ip: Some(ip) })).ok();
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    hide_panel_window(&app);
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let a = app.autolaunch();
    if enabled {
        a.enable().ok();
    } else {
        a.disable().ok();
    }
}

fn rect_px(r: &tauri::Rect, scale: f64) -> (i32, i32, i32, i32) {
    let (x, y) = match r.position {
        tauri::Position::Physical(p) => (p.x, p.y),
        tauri::Position::Logical(l) => ((l.x * scale) as i32, (l.y * scale) as i32),
    };
    let (w, h) = match r.size {
        tauri::Size::Physical(s) => (s.width as i32, s.height as i32),
        tauri::Size::Logical(s) => ((s.width * scale) as i32, (s.height * scale) as i32),
    };
    (x, y, w, h)
}

// Place the panel above the tray icon, clamped to the monitor (Windows taskbar is at the bottom).
fn position_near_tray(app: &AppHandle, win: &tauri::WebviewWindow) {
    let size = match win.outer_size() {
        Ok(s) => s,
        Err(_) => return,
    };
    let (sw, sh) = (size.width as i32, size.height as i32);
    let monitor = win.current_monitor().ok().flatten().or_else(|| app.primary_monitor().ok().flatten());
    let (mx, my, mw, mh) = monitor
        .map(|m| (m.position().x, m.position().y, m.size().width as i32, m.size().height as i32))
        .unwrap_or((0, 0, 1920, 1080));
    let tray = app.try_state::<Shared>().and_then(|s| *s.tray_rect.lock().unwrap());
    let (mut x, mut y) = match tray {
        Some((tx, ty, tw, _th)) => (tx + tw / 2 - sw / 2, ty - sh - 6),
        None => (mx + mw - sw - 12, my + mh - sh - 60),
    };
    x = x.clamp(mx + 8, mx + mw - sw - 8);
    y = y.max(my + 8);
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

fn show_panel(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        position_near_tray(app, &win);
        let _ = win.show();
        let _ = win.set_focus();
        app.emit("panel:show", ()).ok();
        if let Some(shared) = app.try_state::<Shared>() {
            shared.tx.send(Msg::Visible(true)).ok();
            shared.tx.send(Msg::Refresh).ok();
        }
    }
}

fn hide_panel_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().ok();
    }
    app.emit("panel:hide", ()).ok();
    if let Some(shared) = app.try_state::<Shared>() {
        *shared.last_hide.lock().unwrap() = Some(Instant::now());
        shared.tx.send(Msg::Visible(false)).ok();
    }
}

fn toggle_panel(app: &AppHandle, rect: &tauri::Rect) {
    let Some(win) = app.get_webview_window("main") else { return };
    if win.is_visible().unwrap_or(false) {
        hide_panel_window(app);
        return;
    }
    let Some(shared) = app.try_state::<Shared>() else { return };
    let hidden_by_this_click = shared.last_hide.lock().unwrap().is_some_and(|t| t.elapsed() < BLUR_CLICK_WINDOW);
    if hidden_by_this_click {
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    *shared.tray_rect.lock().unwrap() = Some(rect_px(rect, scale));
    show_panel(app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = data_dir(&handle);
            let cert = cert::ensure_cert(&dir).map_err(|e| format!("cert: {e}"))?;

            let (tx, rx) = mpsc::channel::<Msg>();
            app.manage(Shared { view: Mutex::new(json!({ "device": J::Null, "syncing": false, "held": [], "error": J::Null, "updatedAt": J::Null, "source": "local" })), tx, cert: cert.clone(), tray_rect: Mutex::new(None), last_hide: Mutex::new(None) });

            let menu = MenuBuilder::new(app)
                .item(&MenuItemBuilder::with_id("open", "Abrir painel").build(app)?)
                .item(&MenuItemBuilder::with_id("refresh", "Atualizar").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("quit", "Sair").build(app)?)
                .build()?;

            TrayIconBuilder::with_id("main")
                .icon(icon::tray_icon(None, false, [150, 160, 170]))
                .tooltip("WindFree")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_panel(app),
                    "refresh" => {
                        if let Some(s) = app.try_state::<Shared>() {
                            s.tx.send(Msg::Refresh).ok();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = &event {
                        toggle_panel(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            if let Some(win) = app.get_webview_window("main") {
                let h2 = handle.clone();
                win.on_window_event(move |e| {
                    if let WindowEvent::Focused(false) = e {
                        hide_panel_window(&h2);
                    }
                });
            }

            let worker = Worker::new(handle.clone(), dir, cert);
            std::thread::spawn(move || worker_loop(worker, rx));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_state, ac_set, ac_refresh, hide_panel, get_autostart, set_autostart, scan_devices, probe_ip, choose_device])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Tauri")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}
