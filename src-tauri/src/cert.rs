// Generates a client cert on first run (no key shipped) and caches it. The cert
// carries Samsung's public cloud UUID in its subject OU; the AC checks that UUID
// against its ACL, so any locally-generated cert works on your own paired units.
use openssl::asn1::Asn1Time;
use openssl::bn::BigNum;
use openssl::ec::{EcGroup, EcKey};
use openssl::hash::MessageDigest;
use openssl::nid::Nid;
use openssl::pkey::PKey;
use openssl::x509::{X509, X509NameBuilder};
use std::fs;
use std::path::Path;

const CLOUD_UUID: &str = "ab0b0ac4-aae9-4958-a04d-8ec36fe1b2f9";

pub fn ensure_cert(dir: &Path) -> Result<(String, String), String> {
    let cert_path = dir.join("local-cert.pem");
    let key_path = dir.join("local-key.pem");
    if cert_path.exists() && key_path.exists() {
        return Ok((
            fs::read_to_string(&cert_path).map_err(|e| e.to_string())?,
            fs::read_to_string(&key_path).map_err(|e| e.to_string())?,
        ));
    }
    let (cert_pem, key_pem) = generate().map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(&cert_path, &cert_pem).map_err(|e| e.to_string())?;
    fs::write(&key_path, &key_pem).map_err(|e| e.to_string())?;
    Ok((cert_pem, key_pem))
}

fn generate() -> Result<(String, String), openssl::error::ErrorStack> {
    let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1)?;
    let ec = EcKey::generate(&group)?;
    let pkey = PKey::from_ec_key(ec)?;

    let mut name = X509NameBuilder::new()?;
    name.append_entry_by_nid(Nid::ORGANIZATIONALUNITNAME, &format!("uuid:{CLOUD_UUID}"))?;
    name.append_entry_by_text("CN", "WindFree Local")?;
    let name = name.build();

    let mut b = X509::builder()?;
    b.set_version(2)?;
    b.set_subject_name(&name)?;
    b.set_issuer_name(&name)?;
    b.set_pubkey(&pkey)?;
    let not_before = Asn1Time::days_from_now(0)?;
    let not_after = Asn1Time::days_from_now(7300)?;
    let serial = BigNum::from_u32(1)?.to_asn1_integer()?;
    b.set_not_before(&not_before)?;
    b.set_not_after(&not_after)?;
    b.set_serial_number(&serial)?;
    b.sign(&pkey, MessageDigest::sha256())?;
    let cert = b.build();

    let cert_pem = String::from_utf8(cert.to_pem()?).unwrap();
    let key_pem = String::from_utf8(pkey.private_key_to_pem_pkcs8()?).unwrap();
    Ok((cert_pem, key_pem))
}
