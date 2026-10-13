// Find Samsung OCF air conditioners on the LAN (no cloud, no multicast which many
// routers drop): one small CoAP GET /oic/res per host on UDP 5683 finds the OCF
// devices, then DTLS + oic/d gives each one's id.
use crate::ac::{LocalAc, Status};
use std::collections::BTreeSet;
use std::net::UdpSocket;
use std::time::{Duration, Instant};

const COAP_PORT: u16 = 5683;
// Units in Wi-Fi power save can sleep through a single packet, so the sweep is resent a
// few times and listened to for longer than one round trip.
const SWEEP_ROUNDS: u32 = 3;
const SWEEP_RESEND: Duration = Duration::from_millis(600);
const SWEEP_WINDOW: Duration = Duration::from_millis(2500);

pub struct Found {
    pub ip: String,
    pub di: String,
    pub status: Status,
}

pub struct Scan {
    pub network: Option<String>,
    pub responded: usize,
    pub found: Vec<Found>,
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
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else {
        return responders;
    };
    sock.set_read_timeout(Some(Duration::from_millis(100))).ok();
    let start = Instant::now();
    let mut rounds = 0;
    let mut buf = [0u8; 2048];
    while start.elapsed() < SWEEP_WINDOW {
        if rounds < SWEEP_ROUNDS && start.elapsed() >= SWEEP_RESEND * rounds {
            for i in 1..=254u8 {
                let _ = sock.send_to(&res_get(i as u16), (format!("{base}.{i}").as_str(), COAP_PORT));
            }
            rounds += 1;
        }
        if let Ok((_, addr)) = sock.recv_from(&mut buf) {
            responders.insert(addr.ip().to_string());
        }
    }
    responders
}

pub fn probe(ip: &str, cert_pem: &str, key_pem: &str) -> Result<Found, String> {
    let mut ac = LocalAc::connect(ip, cert_pem, key_pem).map_err(|_| "Não consegui conectar a esse IP".to_string())?;
    let di = ac.air_conditioner_id().ok_or("Esse aparelho não é um ar-condicionado Samsung")?;
    let status = ac.get_status(None);
    Ok(Found { ip: ip.to_string(), di, status })
}

pub fn scan(cert_pem: &str, key_pem: &str) -> Scan {
    let Some(network) = local_ipv4().and_then(|ip| ip.rsplit_once('.').map(|(base, _)| base.to_string())) else {
        return Scan { network: None, responded: 0, found: Vec::new() };
    };
    let responders = sweep(&network);
    let found = std::thread::scope(|s| {
        let probes: Vec<_> = responders.iter().map(|ip| s.spawn(move || probe(ip, cert_pem, key_pem).ok())).collect();
        probes.into_iter().filter_map(|p| p.join().ok().flatten()).collect()
    });
    Scan { network: Some(network), responded: responders.len(), found }
}

pub fn resolve_ip(device_id: &str, cert_pem: &str, key_pem: &str) -> Option<String> {
    scan(cert_pem, key_pem).found.into_iter().find(|f| f.di == device_id).map(|f| f.ip)
}
