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
//
// Two-base fallback for RF reachability: api.skipi.app (origin) +
// api-ru.skipi.app (Timeweb-hosted reverse proxy that is reachable
// from Russian ISPs without VPN). When the user leaves Settings at the
// production default we try both; an explicit non-default `server_url`
// is treated as an override and used alone (dev / staging / proxy).

const PRIMARY_API: &str = "https://api.skipi.app";
const RU_API: &str = "https://api-ru.skipi.app";

fn api_bases(s: &Settings) -> Vec<String> {
    let configured = s.server_url.trim_end_matches('/').to_string();
    if configured.is_empty() || configured == PRIMARY_API {
        // Automatic production: origin first, RF bridge as fallback.
        return vec![PRIMARY_API.to_string(), RU_API.to_string()];
    }
    // Manual override — respect verbatim, single candidate.
    vec![configured]
}

fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        // Short connect timeout so a blocked primary endpoint does not
        // freeze the Trade Desk — failover to RU bridge kicks in fast.
        .connect_timeout(std::time::Duration::from_secs(4))
        .timeout(std::time::Duration::from_secs(20))
        // Self-signed certs on dev / api.skipi.app:8443 fallback —
        // accept invalid certs only when targeting a non-public host.
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())
}

/// True if the failure happened before we received an HTTP response
/// from the server. Connection refused, DNS, TLS, timeout. Safe to
/// retry against another base — even for POSTs, because the action
/// did not reach a server.
fn is_pre_response_error(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout() || e.is_request()
}

/// Path-relative API call with automatic primary→RF fallback.
///
/// `path_and_query` must start with `/`. Falls back to the next
/// candidate base on pre-response errors (connect/DNS/TLS/timeout).
/// Does NOT fall back once the server has actually replied — server
/// 4xx/5xx are surfaced as final errors so mutating commands like
/// publish/engage/close/pin don't double-execute.
fn request_api(
    s: &Settings,
    method: reqwest::Method,
    path_and_query: &str,
    bearer: &str,
    body: Option<&JsonValue>,
) -> Result<JsonValue, String> {
    let bases = api_bases(s);
    let last = bases.len().saturating_sub(1);
    let client = http_client()?;
    let mut last_err = String::from("no api bases configured");
    for (i, base) in bases.iter().enumerate() {
        let url = format!("{}{}", base.trim_end_matches('/'), path_and_query);
        let mut req = client.request(method.clone(), &url);
        if !bearer.is_empty() {
            req = req.bearer_auth(bearer);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        match req.send() {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().unwrap_or_default();
                if !status.is_success() {
                    // Real server response — final, do not try next base.
                    return Err(format!("HTTP {}: {}", status.as_u16(), text));
                }
                if text.is_empty() {
                    return Ok(JsonValue::Null);
                }
                return serde_json::from_str(&text)
                    .map_err(|e| format!("decode: {} (body: {})", e, text));
            }
            Err(e) => {
                last_err = format!("{base}: {e}");
                if is_pre_response_error(&e) && i < last {
                    // Try next candidate base.
                    continue;
                }
                return Err(last_err);
            }
        }
    }
    Err(last_err)
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
    let body = serde_json::json!({
        "display_name": display_name,
        "contact_email": contact_email,
        "legal_name": legal_name,
        "jurisdiction": jurisdiction,
        "contact_phone": contact_phone,
    });
    let resp = request_api(&s, reqwest::Method::POST, "/api/brokers", &s.bearer_token, Some(&body))?;
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
    request_api(&s, reqwest::Method::POST, "/api/cargo-listings", &s.bearer_token, Some(&body))
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
    request_api(&s, reqwest::Method::POST, "/api/tonnage-listings", &s.bearer_token, Some(&body))
}

#[tauri::command]
fn fetch_my_cargo(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/cargo-listings?broker_id={}", s.broker_id);
    request_api(&s, reqwest::Method::GET, &path, &s.bearer_token, None)
}

#[tauri::command]
fn fetch_my_tonnage(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/tonnage-listings?broker_id={}", s.broker_id);
    request_api(&s, reqwest::Method::GET, &path, &s.bearer_token, None)
}

#[tauri::command]
fn fetch_matches(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches?broker_id={}", s.broker_id);
    request_api(&s, reqwest::Method::GET, &path, &s.bearer_token, None)
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
    let mut path = format!("/api/matches/inbox?broker_id={}", s.broker_id);
    if let Some(id) = listing_id.as_deref().filter(|x| !x.is_empty()) {
        path.push_str(&format!("&listing_id={}", id));
        if let Some(kind) = listing_kind.as_deref().filter(|x| !x.is_empty()) {
            path.push_str(&format!("&listing_kind={}", kind));
        }
    }
    if include_dismissed.unwrap_or(false) {
        path.push_str("&include_dismissed=true");
    }
    request_api(&s, reqwest::Method::GET, &path, &s.bearer_token, None)
}

#[tauri::command]
fn mark_bazaar_match_seen(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/seen", match_id);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
}

#[tauri::command]
fn dismiss_bazaar_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/dismiss", match_id);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
}

#[tauri::command]
fn pin_bazaar_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/pin", match_id);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
}

#[tauri::command]
fn unpin_bazaar_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/unpin", match_id);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
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
    let path = format!("/api/{}/{}/engage", endpoint, listing_id);
    let body = serde_json::json!({
        "viewer_broker_id": s.broker_id,
        "action": action,
    });
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, Some(&body))
}

#[tauri::command]
fn close_listing(
    state: tauri::State<'_, AppState>,
    kind: String,
    listing_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let endpoint = if kind == "cargo" { "cargo-listings" } else { "tonnage-listings" };
    let path = format!("/api/{}/{}/close", endpoint, listing_id);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
}

#[tauri::command]
fn mark_match_seen(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches/{}/seen?side={}", match_id, side);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
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

    // Write the .eml inside the user's home so snap'd / flatpak'd mail
    // clients (Thunderbird snap, Geary flatpak, etc.) can actually read
    // it. Files in /tmp are invisible to confined apps and the user
    // gets a "File not found" dialog from the launcher.
    let mut path = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no writable home dir".to_string())?;
    path.push("skipi-broker");
    path.push("drafts");
    std::fs::create_dir_all(&path).map_err(|e| format!("mkdir drafts: {e}"))?;
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
    let path = format!("/api/matches/{}/dismiss?side={}", match_id, side);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
}

#[tauri::command]
fn pin_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches/{}/pin?side={}", match_id, side);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
}

#[tauri::command]
fn unpin_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches/{}/unpin?side={}", match_id, side);
    request_api(&s, reqwest::Method::POST, &path, &s.bearer_token, None)
}

/// Trigger the local freight agent (bazaar_push) to scrape mailbox +
/// ShipNext for fresh signals and push them to skipi-server, then
/// recompute matches. Pinned matches survive irrespective of new
/// scoring — that protection lives in the server matcher.
///
/// This is a TYMUR-MACHINE-LOCAL command: it shells out to the Python
/// agent at `/home/linux/scripts/freight_agent/`. On other installs
/// (Sasha's Windows) the agent isn't present and the command returns
/// a friendly error so the UI can show "agent not available here".
#[tauri::command]
fn request_agent_update(
    _state: tauri::State<'_, AppState>,
) -> Result<JsonValue, String> {
    use std::process::Command;

    let agent_dir = std::path::Path::new("/home/linux/scripts");
    let venv_python = agent_dir.join("venv/bin/python");
    if !venv_python.exists() {
        return Err(
            "Агент недоступен на этой машине. Эта функция работает \
             только на локальной установке Тимура (Linux). \
             Свежие совпадения приходят автоматически по расписанию."
                .into(),
        );
    }

    // Read shared admin token + bazaar URL from the same place freight_agent uses.
    // Hardcode dev defaults — broker app on Tymur's machine talks to
    // 127.0.0.1:8000 anyway (see Settings.server_url override).
    let bazaar_url = std::env::var("SKIPI_BAZAAR_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8000".to_string());
    let admin_token = std::env::var("SKIPI_ADMIN_TOKEN")
        .unwrap_or_else(|_| "aCjVedJo87SrtUdNGCcseO9Qtv3R0vpoAlOMkR7xikg".to_string());

    let output = Command::new(&venv_python)
        .args(["-m", "freight_agent.bazaar_push"])
        .current_dir(agent_dir)
        .env("SKIPI_BAZAAR_URL", &bazaar_url)
        .env("SKIPI_ADMIN_TOKEN", &admin_token)
        .output()
        .map_err(|e| format!("spawn agent failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(format!("agent exited {}: {stderr}", output.status));
    }

    // Parse the last "pushed cargo (ins/upd)=N/M, tonnage (ins/upd)=A/B,
    // matches=K, new_offset=..." line — freight_agent emits a fresh
    // one per batch. Take the most recent.
    let combined = format!("{stdout}\n{stderr}");
    let last_summary = combined
        .lines()
        .filter(|l| l.contains("pushed cargo"))
        .last()
        .unwrap_or("");

    // Lightweight parse: grab ins counts and matches count.
    let extract = |key: &str| -> i64 {
        if let Some(start) = last_summary.find(&format!("{key}=")) {
            let rest = &last_summary[start + key.len() + 1..];
            let end = rest.find(|c: char| !c.is_ascii_digit() && c != '/').unwrap_or(rest.len());
            // For "ins/upd" format, take only the ins part.
            let token = &rest[..end];
            let ins = token.split('/').next().unwrap_or("0");
            ins.parse().unwrap_or(0)
        } else {
            0
        }
    };

    let cargo_new = extract("cargo (ins/upd)");
    let tonnage_new = extract("tonnage (ins/upd)");
    let matches_new = extract("matches");

    Ok(serde_json::json!({
        "cargo_inserted": cargo_new,
        "tonnage_inserted": tonnage_new,
        "matches_created": matches_new,
        "raw_last_line": last_summary,
    }))
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
            pin_match,
            unpin_match,
            request_agent_update,
            mark_bazaar_match_seen,
            dismiss_bazaar_match,
            pin_bazaar_match,
            unpin_bazaar_match,
            send_circular_email,
            generate_eml,
            open_whatsapp,
            open_external,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
