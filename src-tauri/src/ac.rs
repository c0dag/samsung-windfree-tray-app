// Clean-room local client for Samsung OCF air conditioners: DTLS 1.2 + CoAP (CBOR)
// straight to the unit on the LAN, no cloud. Blocking; guarded by a Mutex upstream.
#![allow(non_snake_case)]
use ciborium::value::Value;
use openssl::ssl::{SslConnector, SslMethod, SslStream, SslVerifyMode};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::time::Duration;

pub const DTLS_PORT: u16 = 49154;
const PREFIX: &str = "x.com.samsung.da.";

#[derive(Debug)]
struct UdpIo(UdpSocket);
impl Read for UdpIo {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        self.0.recv(b)
    }
}
impl Write for UdpIo {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.send(b)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Serialize, Default, Clone)]
pub struct Status {
    pub nome: Option<String>,
    pub ligado: bool,
    pub temp: Option<i64>,
    pub modo: String,
    pub vento: String,
    pub extra: String,
    pub oscilar: String,
    pub display: String,
    pub bipe: String,
    pub autoclean: String,
    pub ambiente: Option<i64>,
    pub umidade: Option<i64>,
    pub filtroUso: Option<i64>,
    pub filtroAlerta: Option<i64>,
    pub filtroStatus: String,
    pub potencia: i64,
    pub energia: f64,
    pub ambienteExterno: Option<i64>,
}

fn map_from_ocf(table: &[(&str, &str)], ocf: &str) -> Option<String> {
    table.iter().find(|(_, o)| *o == ocf).map(|(a, _)| a.to_string())
}
fn ocf_from_app(table: &[(&str, &str)], app: &str) -> Option<String> {
    table.iter().find(|(a, _)| *a == app).map(|(_, o)| o.to_string())
}

const MODE: &[(&str, &str)] = &[("cool", "Cool"), ("dry", "Dry"), ("wind", "Wind"), ("auto", "Auto")];
const FAN: &[(&str, &str)] = &[("auto", "0"), ("low", "1"), ("medium", "2"), ("high", "3"), ("turbo", "4")];
const SWING: &[(&str, &str)] = &[("fixed", "Fix"), ("vertical", "Up_And_Low"), ("horizontal", "Left_And_Right"), ("all", "All")];
const EXTRA: &[(&str, &str)] = &[("off", "Off"), ("sleep", "Sleep"), ("quiet", "Quiet"), ("speed", "Speed"), ("windFree", "Nano"), ("windFreeSleep", "NanoSleep")];

// --- CBOR helpers ---
fn cbor_get<'a>(map: &'a Value, key: &str) -> Option<&'a Value> {
    if let Value::Map(entries) = map {
        let prefixed = format!("{PREFIX}{key}");
        for (k, v) in entries {
            if let Value::Text(t) = k {
                if t == &prefixed || t == key {
                    return Some(v);
                }
            }
        }
    }
    None
}
fn as_text(v: &Value) -> Option<String> {
    match v {
        Value::Text(s) => Some(s.clone()),
        _ => None,
    }
}
fn as_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Integer(i) => (*i).try_into().ok(),
        Value::Float(f) => Some(*f as i64),
        Value::Text(s) => s.trim().parse::<f64>().ok().map(|f| f as i64),
        _ => None,
    }
}
fn get_text(map: &Value, key: &str) -> Option<String> {
    cbor_get(map, key).and_then(as_text)
}
fn get_i64(map: &Value, key: &str) -> Option<i64> {
    cbor_get(map, key).and_then(as_i64)
}

// --- CoAP framing (RFC 7252) ---
fn build_message(mid: u16, method: u8, path: &str, payload: Option<&Value>) -> Vec<u8> {
    let token = (mid & 0xff) as u8;
    let mut msg = vec![0x41, method, (mid >> 8) as u8, token, token];
    let mut prev = 0u16;
    for seg in path.split('/') {
        let delta = (11 - prev) as u8;
        prev = 11;
        let b = seg.as_bytes();
        if b.len() < 13 {
            msg.push((delta << 4) | b.len() as u8);
        } else {
            msg.push((delta << 4) | 13);
            msg.push((b.len() - 13) as u8);
        }
        msg.extend_from_slice(b);
    }
    if let Some(p) = payload {
        msg.extend_from_slice(&[0x11, 60, 0xff]); // Content-Format=CBOR(60), payload marker
        let mut buf = Vec::new();
        ciborium::ser::into_writer(p, &mut buf).ok();
        msg.extend_from_slice(&buf);
    }
    msg
}

fn parse_response(data: &[u8]) -> (String, Option<Value>) {
    let code = format!("{}.{:02}", (data[1] >> 5) & 7, data[1] & 0x1f);
    let tkl = (data[0] & 0x0f) as usize;
    let mut pos = 4 + tkl;
    while pos < data.len() {
        if data[pos] == 0xff {
            let payload: Option<Value> = ciborium::de::from_reader(&data[pos + 1..]).ok();
            return (code, payload);
        }
        let mut delta = (data[pos] >> 4) & 0x0f;
        let mut length = (data[pos] & 0x0f) as usize;
        pos += 1;
        if delta == 13 {
            pos += 1;
        } else if delta == 14 {
            pos += 2;
        }
        let _ = &mut delta;
        if length == 13 {
            length = data[pos] as usize + 13;
            pos += 1;
        } else if length == 14 {
            length = ((data[pos] as usize) << 8 | data[pos + 1] as usize) + 269;
            pos += 2;
        }
        pos += length;
    }
    (code, None)
}

pub struct LocalAc {
    stream: SslStream<UdpIo>,
    mid: u16,
}

impl LocalAc {
    pub fn connect(ip: &str, cert_pem: &str, key_pem: &str) -> Result<LocalAc, String> {
        let cert = openssl::x509::X509::from_pem(cert_pem.as_bytes()).map_err(|e| e.to_string())?;
        let key = openssl::pkey::PKey::private_key_from_pem(key_pem.as_bytes()).map_err(|e| e.to_string())?;
        let mut b = SslConnector::builder(SslMethod::dtls()).map_err(|e| e.to_string())?;
        b.set_certificate(&cert).map_err(|e| e.to_string())?;
        b.set_private_key(&key).map_err(|e| e.to_string())?;
        b.set_verify(SslVerifyMode::NONE);
        let connector = b.build();

        let udp = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
        udp.connect((ip, DTLS_PORT)).map_err(|e| e.to_string())?;
        udp.set_read_timeout(Some(Duration::from_secs(6))).map_err(|e| e.to_string())?;

        let cfg = connector
            .configure()
            .map_err(|e| e.to_string())?
            .verify_hostname(false)
            .use_server_name_indication(false);
        let stream = cfg.connect("ac", UdpIo(udp)).map_err(|e| format!("handshake DTLS: {e}"))?;
        Ok(LocalAc { stream, mid: rand::random() })
    }

    fn request(&mut self, method: u8, path: &str, payload: Option<&Value>) -> Result<(String, Option<Value>), String> {
        self.mid = self.mid.wrapping_add(1);
        let token = (self.mid & 0xff) as u8;
        let msg = build_message(self.mid, method, path, payload);
        self.stream.write_all(&msg).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 4096];
        for _ in 0..3 {
            let n = self.stream.read(&mut buf).map_err(|e| e.to_string())?;
            if n >= 5 && buf[4] == token {
                return Ok(parse_response(&buf[..n]));
            }
        }
        Err(format!("sem resposta para {path}"))
    }

    fn get(&mut self, path: &str) -> Option<Value> {
        self.request(1, path, None).ok().and_then(|(_, v)| v)
    }

    pub fn post(&mut self, path: &str, payload: Value) -> Result<String, String> {
        self.request(2, path, Some(&payload)).map(|(code, _)| code)
    }

    pub fn device_id(&mut self) -> Option<String> {
        self.get("oic/d").and_then(|v| get_text(&v, "di"))
    }

    // TVs, fridges and other SmartThings appliances answer the same discovery and accept
    // the same cert, so only take units that report themselves as air conditioners.
    pub fn air_conditioner_id(&mut self) -> Option<String> {
        let d = self.get("oic/d")?;
        let is_ac = matches!(cbor_get(&d, "rt"), Some(Value::Array(rt)) if rt.iter().filter_map(as_text).any(|t| t == "oic.d.airconditioner"));
        if is_ac {
            get_text(&d, "di")
        } else {
            None
        }
    }

    pub fn get_status(&mut self, nome: Option<String>) -> Status {
        let power = self.get("power/vs/0");
        let mode = self.get("mode/vs/0");
        let cur = self.get("temperature/current/0");
        let temps = self.get("temperatures/vs/0");
        let wind = self.get("wind/strength/vs/0");
        let dir = self.get("wind/direction/vs/0");
        let hum = self.get("humidity/vs/0");
        let conv = self.get("mode/convenient/vs/0");
        let clean = self.get("option/autoclean/vs/0");
        let filter = self.get("filter/airdustfilter/vs/0");
        let energy = self.get("energy/consumption/vs/0");

        let options: Vec<String> = mode
            .as_ref()
            .and_then(|m| cbor_get(m, "options"))
            .and_then(|v| if let Value::Array(a) = v { Some(a.iter().filter_map(as_text).collect()) } else { None })
            .unwrap_or_default();
        let has = |t: &str| options.iter().any(|o| o == t);
        let outdoor = options.iter().find(|o| o.starts_with("OutdoorTemp_")).and_then(|o| o.split('_').nth(1)?.parse::<f64>().ok()).map(|f| ((f - 32.0) * 5.0 / 9.0).round() as i64);

        let modo_ocf = mode.as_ref().and_then(|m| cbor_get(m, "modes")).and_then(|v| if let Value::Array(a) = v { a.first().and_then(as_text) } else { as_text(v) }).unwrap_or_default();
        let target = temps.as_ref().and_then(|t| cbor_get(t, "items")).and_then(|v| if let Value::Array(a) = v { a.first().cloned() } else { None }).and_then(|item| get_i64(&item, "desired"));
        let fan_idx = wind.as_ref().and_then(|w| get_text(w, "modes")).unwrap_or_default();

        Status {
            nome,
            ligado: power.as_ref().and_then(|p| get_text(p, "power")).as_deref() == Some("On"),
            temp: target,
            modo: map_from_ocf(MODE, &modo_ocf).unwrap_or_else(|| "cool".into()),
            vento: map_from_ocf(FAN, &fan_idx).unwrap_or_else(|| "auto".into()),
            extra: conv.as_ref().and_then(|c| get_text(c, "modes")).and_then(|m| map_from_ocf(EXTRA, &m)).unwrap_or_else(|| "off".into()),
            oscilar: dir.as_ref().and_then(|d| get_text(d, "modes")).and_then(|m| map_from_ocf(SWING, &m)).unwrap_or_else(|| "fixed".into()),
            display: if has("Light_On") { "off".into() } else { "on".into() },
            bipe: if has("Volume_100") { "on".into() } else { "off".into() },
            autoclean: if clean.as_ref().and_then(|c| get_text(c, "settingStatus")).as_deref() == Some("On") { "on".into() } else { "off".into() },
            ambiente: cur.as_ref().and_then(|c| get_i64(c, "temperature")),
            umidade: hum.as_ref().and_then(|h| get_i64(h, "fivepercentHumidity")),
            filtroUso: filter.as_ref().and_then(|f| get_i64(f, "filterUsage")),
            filtroAlerta: filter.as_ref().and_then(|f| get_i64(f, "filterCapacity")).or(Some(500)),
            filtroStatus: filter.as_ref().and_then(|f| get_text(f, "filterStatus")).unwrap_or_else(|| "normal".into()),
            potencia: energy.as_ref().and_then(|e| get_i64(e, "power")).unwrap_or(0),
            energia: ((energy.as_ref().and_then(|e| get_i64(e, "cumulativePower")).unwrap_or(0) as f64) / 1000.0 * 10.0).round() / 10.0,
            ambienteExterno: outdoor,
        }
    }

    // Returns the CoAP code (2.04 = accepted).
    pub fn set(&mut self, key: &str, value: &str) -> Result<String, String> {
        let p = |k: &str, v: Value| (k.to_string(), v);
        let (path, payload) = match key {
            "ligado" => p("power/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}power")), Value::Text(if value == "true" { "On" } else { "Off" }.into()))])),
            "temp" => p("temperature/desired/0", Value::Map(vec![(Value::Text("temperature".into()), Value::Integer(value.parse::<i64>().unwrap_or(24).into()))])),
            "modo" => p("mode/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}modes")), Value::Array(vec![Value::Text(ocf_from_app(MODE, value).unwrap_or_default())]))])),
            "vento" => p("wind/strength/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}modes")), Value::Text(ocf_from_app(FAN, value).unwrap_or_default()))])),
            "oscilar" => p("wind/direction/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}modes")), Value::Text(ocf_from_app(SWING, value).unwrap_or_default()))])),
            "extra" => p("mode/convenient/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}modes")), Value::Text(ocf_from_app(EXTRA, value).unwrap_or_default()))])),
            "display" => p("mode/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}options")), Value::Array(vec![Value::Text(if value == "on" { "Light_Off" } else { "Light_On" }.into())]))])),
            "bipe" => p("mode/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}options")), Value::Array(vec![Value::Text(if value == "on" { "Volume_100" } else { "Volume_Mute" }.into())]))])),
            "autoclean" => p("option/autoclean/vs/0", Value::Map(vec![(Value::Text(format!("{PREFIX}settingStatus")), Value::Text(if value == "on" { "On" } else { "Off" }.into()))])),
            _ => return Err(format!("chave desconhecida: {key}")),
        };
        self.post(&path, payload)
    }
}
