//! Skipi Broker — Tauri commands.
//!
//! The desktop app is a thin shell over skipi-server's broker
//! endpoints: it stores connection settings + a participant identity
//! locally, then exposes `invoke` commands the HTML/JS UI calls to
//! publish listings, fetch matches, and engage. There is NO local DB
//! — all state lives on the server, the client is stateless beyond
//! settings.json.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::PathBuf;
use std::sync::Mutex;

// ---------- Settings ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SmtpConfig {
    pub host: String,         // smtp.gmail.com
    pub port: u16,            // 465 for SMTPS, 587 for STARTTLS
    pub username: String,
    pub password: String,     // App Password / SMTP password
    pub from_email: String,   // From: header
    pub from_name: String,    // optional display name
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Settings {
    /// Skipi server base URL — defaults to api.skipi.app on first run.
    pub server_url: String,
    /// Shared admin token until per-broker tokens ship. Empty in dev.
    pub bearer_token: String,
    /// UUID of the participant row on the server (the Broker.id).
    pub broker_id: String,
    /// Display name shown to opposite side on a match. Snapshot from
    /// the server profile so the UI can render before the round-trip.
    pub display_name: String,
    /// Default reply_to for publishes — usually the participant's own
    /// commercial email. Per-listing override available in the wizard.
    pub reply_to: String,

    /// Email channel — when configured, every successful Circulate
    /// also fans out a circular email to `recipients` via SMTP.
    pub smtp: SmtpConfig,
    /// Recipient list for circular emails. One email per line in the
    /// settings UI; persisted as Vec<String>.
    pub recipients: Vec<String>,
}

impl Settings {
    fn config_path() -> PathBuf {
        let dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("skipi-broker");
        std::fs::create_dir_all(&dir).ok();
        dir.join("settings.json")
    }

    pub fn load() -> Self {
        // First-run default points at production. Switch to local dev
        // via Settings → Connection.
        let first_run = || Settings {
            server_url: "https://api.skipi.app".to_string(),
            ..Default::default()
        };
        let raw = match std::fs::read_to_string(Self::config_path()) {
            Ok(s) => s,
            Err(_) => return first_run(),
        };
        serde_json::from_str(&raw).unwrap_or_else(|_| first_run())
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        let body = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, body).map_err(|e| e.to_string())
    }
}

pub struct AppState {
    pub settings: Mutex<Settings>,
}

// ---------- HTTP helper ----------

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        // Self-signed certs on dev / api.skipi.app:8443 fallback —
        // accept invalid certs only when targeting a non-public host.
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())
}

fn request(
    method: reqwest::Method,
    url: &str,
    bearer: &str,
    body: Option<&JsonValue>,
) -> Result<JsonValue, String> {
    let client = http_client()?;
    let mut req = client.request(method, url);
    if !bearer.is_empty() {
        req = req.bearer_auth(bearer);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req.send().map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }
    if text.is_empty() {
        return Ok(JsonValue::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("decode: {} (body: {})", e, text))
}

fn settings_snapshot(state: &AppState) -> Settings {
    state.settings.lock().unwrap().clone()
}

// ---------- Email (SMTP) ----------

fn send_smtp_circular(
    smtp: &SmtpConfig,
    recipients: &[String],
    subject: &str,
    body_text: &str,
) -> Result<usize, String> {
    use lettre::message::{header, Mailbox, Message};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::transport::smtp::SmtpTransport;
    use lettre::Transport;

    if smtp.host.is_empty() || smtp.from_email.is_empty() {
        return Err("SMTP not configured — fill Settings → Circular email first.".into());
    }
    if recipients.is_empty() {
        return Err("Recipient list is empty — add recipients in Settings → Circular email.".into());
    }

    let from: Mailbox = if smtp.from_name.is_empty() {
        smtp.from_email.parse().map_err(|e| format!("from_email parse: {e}"))?
    } else {
        format!("{} <{}>", smtp.from_name, smtp.from_email)
            .parse()
            .map_err(|e| format!("from header: {e}"))?
    };

    // One message per recipient — circular convention is a single
    // To: with everyone hidden in BCC, but to keep deliverability
    // clean (and avoid spamtraps screaming "mass mail"), iterate.
    let creds = Credentials::new(smtp.username.clone(), smtp.password.clone());
    let transport = if smtp.port == 587 {
        SmtpTransport::starttls_relay(&smtp.host)
            .map_err(|e| format!("SMTP starttls: {e}"))?
            .port(smtp.port)
            .credentials(creds)
            .build()
    } else {
        SmtpTransport::relay(&smtp.host)
            .map_err(|e| format!("SMTP relay: {e}"))?
            .port(smtp.port)
            .credentials(creds)
            .build()
    };

    let mut sent = 0usize;
    let mut last_err: Option<String> = None;
    for to in recipients {
        let to_mb: Mailbox = match to.parse() {
            Ok(mb) => mb,
            Err(e) => { last_err = Some(format!("bad recipient {to}: {e}")); continue; }
        };
        let email = match Message::builder()
            .from(from.clone())
            .to(to_mb)
            .subject(subject)
            .header(header::ContentType::TEXT_PLAIN)
            .body(body_text.to_string())
        {
            Ok(m) => m,
            Err(e) => { last_err = Some(format!("build {to}: {e}")); continue; }
        };
        match transport.send(&email) {
            Ok(_) => { sent += 1; }
            Err(e) => { last_err = Some(format!("send {to}: {e}")); }
        }
    }
    if sent == 0 {
        return Err(last_err.unwrap_or_else(|| "no emails sent".into()));
    }
    Ok(sent)
}

// ---------- Tauri commands ----------

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    settings_snapshot(&state)
}

#[tauri::command]
fn save_settings(
    state: tauri::State<'_, AppState>,
    incoming: Settings,
) -> Result<Settings, String> {
    incoming.save()?;
    *state.settings.lock().unwrap() = incoming.clone();
    Ok(incoming)
}

#[tauri::command]
fn register_broker(
    state: tauri::State<'_, AppState>,
    display_name: String,
    contact_email: String,
    legal_name: Option<String>,
    jurisdiction: Option<String>,
    contact_phone: Option<String>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/brokers", s.server_url);
    let body = serde_json::json!({
        "display_name": display_name,
        "contact_email": contact_email,
        "legal_name": legal_name,
        "jurisdiction": jurisdiction,
        "contact_phone": contact_phone,
    });
    let resp = request(reqwest::Method::POST, &url, &s.bearer_token, Some(&body))?;
    // Auto-persist the new broker_id so the user doesn't have to copy it.
    if let Some(id) = resp.get("id").and_then(|v| v.as_str()) {
        let mut updated = s.clone();
        updated.broker_id = id.to_string();
        updated.display_name = display_name;
        updated.reply_to = contact_email;
        updated.save()?;
        *state.settings.lock().unwrap() = updated;
    }
    Ok(resp)
}

#[tauri::command]
fn publish_cargo(
    state: tauri::State<'_, AppState>,
    draft: JsonValue,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let mut body = draft;
    body["broker_id"] = JsonValue::String(s.broker_id.clone());
    if body.get("reply_to").is_none() && !s.reply_to.is_empty() {
        body["reply_to"] = JsonValue::String(s.reply_to.clone());
    }
    let url = format!("{}/api/cargo-listings", s.server_url);
    request(reqwest::Method::POST, &url, &s.bearer_token, Some(&body))
}

#[tauri::command]
fn publish_tonnage(
    state: tauri::State<'_, AppState>,
    draft: JsonValue,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let mut body = draft;
    body["broker_id"] = JsonValue::String(s.broker_id.clone());
    if body.get("reply_to").is_none() && !s.reply_to.is_empty() {
        body["reply_to"] = JsonValue::String(s.reply_to.clone());
    }
    let url = format!("{}/api/tonnage-listings", s.server_url);
    request(reqwest::Method::POST, &url, &s.bearer_token, Some(&body))
}

#[tauri::command]
fn fetch_my_cargo(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/cargo-listings?broker_id={}", s.server_url, s.broker_id);
    request(reqwest::Method::GET, &url, &s.bearer_token, None)
}

#[tauri::command]
fn fetch_my_tonnage(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/tonnage-listings?broker_id={}", s.server_url, s.broker_id);
    request(reqwest::Method::GET, &url, &s.bearer_token, None)
}

#[tauri::command]
fn fetch_matches(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/matches?broker_id={}", s.server_url, s.broker_id);
    request(reqwest::Method::GET, &url, &s.bearer_token, None)
}

/// 4-panel UX inbox: returns own × own + own × bazaar matches with
/// embedded signal payloads. When `listing_id` is set, scope to a
/// single P1 row's match feed. Empty `listing_id` returns the full
/// queue across all of the broker's listings.
#[tauri::command]
fn fetch_matches_inbox(
    state: tauri::State<'_, AppState>,
    listing_id: Option<String>,
    listing_kind: Option<String>,
    include_dismissed: Option<bool>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let mut url = format!(
        "{}/api/matches/inbox?broker_id={}",
        s.server_url, s.broker_id
    );
    if let Some(id) = listing_id.as_deref().filter(|x| !x.is_empty()) {
        url.push_str(&format!("&listing_id={}", id));
        if let Some(kind) = listing_kind.as_deref().filter(|x| !x.is_empty()) {
            url.push_str(&format!("&listing_kind={}", kind));
        }
    }
    if include_dismissed.unwrap_or(false) {
        url.push_str("&include_dismissed=true");
    }
    request(reqwest::Method::GET, &url, &s.bearer_token, None)
}

#[tauri::command]
fn mark_bazaar_match_seen(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/bazaar-matches/{}/seen", s.server_url, match_id);
    request(reqwest::Method::POST, &url, &s.bearer_token, None)
}

#[tauri::command]
fn dismiss_bazaar_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/bazaar-matches/{}/dismiss", s.server_url, match_id);
    request(reqwest::Method::POST, &url, &s.bearer_token, None)
}

#[tauri::command]
fn engage_listing(
    state: tauri::State<'_, AppState>,
    kind: String,
    listing_id: String,
    action: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let endpoint = if kind == "cargo" { "cargo-listings" } else { "tonnage-listings" };
    let url = format!("{}/api/{}/{}/engage", s.server_url, endpoint, listing_id);
    let body = serde_json::json!({
        "viewer_broker_id": s.broker_id,
        "action": action,
    });
    request(reqwest::Method::POST, &url, &s.bearer_token, Some(&body))
}

#[tauri::command]
fn close_listing(
    state: tauri::State<'_, AppState>,
    kind: String,
    listing_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let endpoint = if kind == "cargo" { "cargo-listings" } else { "tonnage-listings" };
    let url = format!("{}/api/{}/{}/close", s.server_url, endpoint, listing_id);
    request(reqwest::Method::POST, &url, &s.bearer_token, None)
}

#[tauri::command]
fn mark_match_seen(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/matches/{}/seen?side={}", s.server_url, match_id, side);
    request(reqwest::Method::POST, &url, &s.bearer_token, None)
}

#[tauri::command]
fn send_circular_email(
    state: tauri::State<'_, AppState>,
    subject: String,
    body: String,
) -> Result<usize, String> {
    let s = settings_snapshot(&state);
    send_smtp_circular(&s.smtp, &s.recipients, &subject, &body)
}

// ---------- Counterparty channels: .eml + WhatsApp deep-link ----------
//
// Two viral, ToS-safe outbound channels alongside the conditional E2E
// chat (which only works when both parties are on Skipi). The Tauri
// app composes the message and hands off to the OS; the user dispatches
// from their authenticated mail client / WA Desktop. No SMTP creds, no
// WA Web wrapping, no Business API — both are zero-risk.
//
// The "Sent via Skipi" footer rides inside the message body so the
// viral hook persists regardless of which channel is used.

fn open_path_or_url(target: &str) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "linux")]
    let result = Command::new("xdg-open").arg(target).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(target).spawn();
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd").args(["/C", "start", "", target]).spawn();
    result.map(|_| ()).map_err(|e| format!("open failed: {e}"))
}

fn url_percent_encode(input: &str) -> String {
    // Conservative percent-encoding for the WhatsApp text payload —
    // RFC 3986 unreserved set + a few safe punctuation chars are
    // passed through; everything else gets %HH.
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        let c = byte as char;
        let is_safe = c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~');
        if is_safe {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn rfc822_now() -> String {
    // Minimal RFC 2822 / 5322 Date: header. chrono::Local::format with
    // "%a, %d %b %Y %H:%M:%S %z" produces the canonical form.
    chrono::Local::now()
        .format("%a, %d %b %Y %H:%M:%S %z")
        .to_string()
}

/// Compose an RFC 822 .eml file with the broker's identity in From:
/// and the counterparty in To:, write it to a temp file, and hand it
/// off to the OS so the user's default mail client opens it as a
/// pre-filled draft. The user reviews and hits Send themselves; their
/// own mail client retains the canonical Sent record.
#[tauri::command]
fn generate_eml(
    state: tauri::State<'_, AppState>,
    to_email: String,
    to_name: Option<String>,
    subject: String,
    body: String,
) -> Result<String, String> {
    let s = settings_snapshot(&state);
    if s.reply_to.is_empty() {
        return Err("Reply-to email not set — open Settings and configure your address first.".into());
    }

    let from_header = if s.display_name.is_empty() {
        s.reply_to.clone()
    } else {
        format!("{} <{}>", s.display_name, s.reply_to)
    };
    let to_header = match to_name {
        Some(n) if !n.is_empty() => format!("{} <{}>", n, to_email),
        _ => to_email.clone(),
    };

    // The viral footer rides inside the body — it travels with the
    // message regardless of forwarding. Keep it minimal to avoid
    // looking like a marketing signature.
    let body_with_footer = format!("{}\n\n--\nSent via Skipi", body);

    let eml = format!(
        "Date: {date}\r\n\
         From: {from}\r\n\
         To: {to}\r\n\
         Subject: {subject}\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: text/plain; charset=UTF-8\r\n\
         Content-Transfer-Encoding: 8bit\r\n\
         X-Skipi-Channel: eml-handoff\r\n\
         \r\n\
         {body}\r\n",
        date = rfc822_now(),
        from = from_header,
        to = to_header,
        subject = subject,
        body = body_with_footer,
    );

    // Temp file with .eml extension so the OS picks the right handler.
    let mut path = std::env::temp_dir();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    path.push(format!("skipi-broker-{}-{}.eml", stamp, uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, eml).map_err(|e| format!("write .eml: {e}"))?;

    open_path_or_url(path.to_string_lossy().as_ref())?;
    Ok(path.to_string_lossy().to_string())
}

/// Open WhatsApp with a pre-filled message via the whatsapp:// URL
/// scheme. The user's authenticated WA Desktop / WA Web picks up the
/// payload and the user hits Send themselves.
///
/// `phone` should be digits only (no +/spaces/dashes) — WA format.
/// The function strips formatting characters defensively.
#[tauri::command]
fn open_whatsapp(
    state: tauri::State<'_, AppState>,
    phone: String,
    message: String,
) -> Result<String, String> {
    let _ = state; // currently no settings dependency, kept for parity
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return Err("Phone number missing or had no digits.".into());
    }
    let body_with_footer = format!("{}\n\n— Sent via Skipi", message);
    let encoded = url_percent_encode(&body_with_footer);
    let url = format!("whatsapp://send?phone={}&text={}", digits, encoded);
    open_path_or_url(&url)?;
    Ok(url)
}

/// Open an arbitrary external URL via the OS handler. Used by the UI
/// to link to ShipNext entry pages, news headlines, etc.
#[tauri::command]
fn open_external(_state: tauri::State<'_, AppState>, url: String) -> Result<(), String> {
    open_path_or_url(&url)
}

#[tauri::command]
fn dismiss_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let url = format!("{}/api/matches/{}/dismiss?side={}", s.server_url, match_id, side);
    request(reqwest::Method::POST, &url, &s.bearer_token, None)
}

// ---------- App entry ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState { settings: Mutex::new(Settings::load()) })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            register_broker,
            publish_cargo,
            publish_tonnage,
            fetch_my_cargo,
            fetch_my_tonnage,
            fetch_matches,
            fetch_matches_inbox,
            engage_listing,
            close_listing,
            mark_match_seen,
            dismiss_match,
            mark_bazaar_match_seen,
            dismiss_bazaar_match,
            send_circular_email,
            generate_eml,
            open_whatsapp,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
