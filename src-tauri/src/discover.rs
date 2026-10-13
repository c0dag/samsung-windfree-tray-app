// Find Samsung OCF air conditioners on the LAN (no cloud, no multicast which many
// routers drop): one small CoAP GET /oic/res per host on UDP 5683 finds the OCF
// devices, then DTLS + oic/d gives each one's id.
use crate::ac::LocalAc;
use std::collections::BTreeSet;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

const COAP_PORT: u16 = 5683;

pub struct Found {
    pub ip: String,
    pub di: String,
}

fn local_ipv4() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) if !v4.is_link_local() => Some(v4.to_string()),
        _ => None,
    }
}

fn res_get(mid: u16) -> Vec<u8> {
    let t = (mid & 0xff) as u8;
    let mut m = vec![0x51, 0x01, (mid >> 8) as u8, t, t];
    m.extend_from_slice(&[(11 << 4) | 3]);
    m.extend_from_slice(b"oic");
    m.extend_from_slice(&[0x03]);
    m.extend_from_slice(b"res");
    m
}

fn sweep(base: &str) -> BTreeSet<String> {
    let mut responders = BTreeSet::new();
    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return responders,
    };
    sock.set_read_timeout(Some(Duration::from_millis(200))).ok();
    for i in 1..=254u8 {
        let _ = sock.send_to(&res_get(i as u16), (format!("{base}.{i}").as_str(), COAP_PORT));
    }
    let deadline = Instant::now() + Duration::from_millis(1500);
    let mut buf = [0u8; 2048];
    while Instant::now() < deadline {
        match sock.recv_from(&mut buf) {
            Ok((_, addr)) => {
                responders.insert(addr.ip().to_string());
            }
            Err(_) => {}
        }
    }
    responders
}

pub fn discover(cert_pem: &str, key_pem: &str) -> Vec<Found> {
    let base = match local_ipv4() {
        Some(ip) => ip.rsplitn(2, '.').nth(1).unwrap_or("").to_string(),
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for ip in sweep(&base) {
        if let Ok(mut ac) = LocalAc::connect(&ip, cert_pem, key_pem) {
            if let Some(di) = ac.device_id() {
                out.push(Found { ip, di });
            }
        }
    }
    out
}

pub fn resolve_ip(device_id: &str, cert_pem: &str, key_pem: &str) -> Option<String> {
    discover(cert_pem, key_pem).into_iter().find(|f| f.di == device_id).map(|f| f.ip)
}
