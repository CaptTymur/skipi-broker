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
use std::sync::{Mutex, OnceLock};

mod feedback;

// ---------- Settings ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SmtpConfig {
    pub host: String, // smtp.gmail.com
    pub port: u16,    // 465 for SMTPS, 587 for STARTTLS
    pub username: String,
    pub password: String,   // App Password / SMTP password
    pub from_email: String, // From: header
    pub from_name: String,  // optional display name
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

    /// Team chat nickname — short label sent as `sender_nickname`
    /// when posting to /api/team/messages. Empty falls back to
    /// `display_name`. Local-only field, never sent to listings.
    pub team_nickname: String,

    /// Ollama-compatible base URL for the broker-LLM consultant.
    /// Empty / unset means `http://localhost:11434` (the default for
    /// Tymur on the Linux box where broker-qwen lives). Sasha and the
    /// Mac install need to point to a reachable host (Tailscale IP,
    /// LAN address, or proxy URL) — same model name `broker-qwen`.
    pub llm_url: String,
}

impl Settings {
    fn config_path() -> PathBuf {
        // Android: dirs::config_dir() returns None / "/.config" which is
        // unreachable from a sandboxed app. Use the package's internal
        // files dir directly so settings actually persist between launches.
        #[cfg(target_os = "android")]
        {
            let dir = PathBuf::from("/data/data/app.skipi.broker/files/skipi-broker");
            std::fs::create_dir_all(&dir).ok();
            return dir.join("settings.json");
        }
        #[cfg(not(target_os = "android"))]
        {
            let dir = dirs::config_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("skipi-broker");
            std::fs::create_dir_all(&dir).ok();
            dir.join("settings.json")
        }
    }

    pub fn load() -> Self {
        // First-run default uses the RF-friendly Timeweb bridge.
        // Switch to local dev via Settings -> Connection.
        let first_run = || Settings {
            server_url: RU_API.to_string(),
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
    /// Last API base that successfully answered a request. Lets us skip
    /// the 4s TCP-timeout probe against a blocked primary on every call
    /// once we've discovered the RF bridge works. Cleared when the
    /// cached base fails pre-response (network changes, proxy outage).
    pub active_api_base: Mutex<Option<String>>,
}

// ---------- HTTP helper ----------
//
// Two-base fallback for RF reachability: api-ru.skipi.app
// (Timeweb-hosted reverse proxy that is reachable from Russian ISPs
// without VPN) + api.skipi.app (origin). When the user leaves Settings
// at a production default we try both; an explicit non-default
// `server_url` is treated as an override and used alone (dev / staging
// / proxy).

const PRIMARY_API: &str = "https://api.skipi.app";
const RU_API: &str = "https://api-ru.skipi.app";

fn api_bases(s: &Settings) -> Vec<String> {
    let configured = s.server_url.trim_end_matches('/').to_string();
    if configured.is_empty() || configured == RU_API {
        // Empty/default RF production: RF bridge first, origin as fallback.
        return vec![RU_API.to_string(), PRIMARY_API.to_string()];
    }
    if configured == PRIMARY_API {
        // If the operator explicitly selected origin, don't pay the RF
        // bridge timeout on every cold start.
        return vec![PRIMARY_API.to_string(), RU_API.to_string()];
    }
    // Manual override — respect verbatim, single candidate.
    vec![configured]
}

static HTTP_CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();

fn http_client() -> reqwest::blocking::Client {
    HTTP_CLIENT
        .get_or_init(|| {
            let builder = reqwest::blocking::Client::builder()
                // Short connect timeout so a blocked primary endpoint does not
                // freeze the Trade Desk — failover to RU bridge kicks in fast.
                .connect_timeout(std::time::Duration::from_secs(4))
                .timeout(std::time::Duration::from_secs(12));
            // T7 (security): accept invalid TLS certs ONLY in debug (dev / self-
            // signed api.skipi.app:8443). Release validates certs — prod hosts
            // (api.skipi.app, api-ru.skipi.app) have valid certificates, so this
            // closes the MITM surface without breaking connectivity.
            #[cfg(debug_assertions)]
            let builder = builder.danger_accept_invalid_certs(true);
            builder
                .build()
                .expect("build broker HTTP client")
        })
        .clone()
}

/// True if the failure happened before we received an HTTP response
/// from the server. Connection refused, DNS, TLS, timeout. Safe to
/// retry against another base — even for POSTs, because the action
/// did not reach a server.
fn is_pre_response_error(e: &reqwest::Error) -> bool {
    e.is_connect() || e.is_timeout() || e.is_request()
}

/// Path-relative API call with automatic primary→RF fallback +
/// active-base caching to avoid re-probing a blocked primary on every
/// call.
///
/// On first call (cache empty) we walk `api_bases()` in order: the
/// first base that returns a server response (any status) becomes the
/// cached active base. Subsequent calls go straight to it. If the
/// cached base errors pre-response (network change, proxy died), we
/// clear the cache and walk the candidates again from the top.
///
/// POSTs do NOT fall back once a server has actually replied —
/// publish/engage/close/pin would otherwise risk duplicate execution.
async fn spawn_blocking_result<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn request_api_blocking(
    s: Settings,
    method: reqwest::Method,
    path_and_query: String,
    body: Option<JsonValue>,
    cached: Option<String>,
) -> Result<(JsonValue, String), String> {
    let all_bases = api_bases(&s);
    let client = http_client();

    // Build the candidate order: cached active base first (if any and
    // still allowed by current settings), then the rest of the list.
    let mut bases: Vec<String> = Vec::with_capacity(all_bases.len());
    if let Some(c) = cached
        .as_ref()
        .filter(|c| all_bases.iter().any(|b| b == *c))
    {
        bases.push(c.clone());
        for b in &all_bases {
            if b != c {
                bases.push(b.clone());
            }
        }
    } else {
        bases = all_bases;
    }
    let last = bases.len().saturating_sub(1);

    let mut last_err = String::from("no api bases configured");
    for (i, base) in bases.iter().enumerate() {
        let url = format!("{}{}", base.trim_end_matches('/'), path_and_query);
        let mut req = client.request(method.clone(), &url);
        if !s.bearer_token.is_empty() {
            req = req.bearer_auth(&s.bearer_token);
        }
        if let Some(b) = body.as_ref() {
            req = req.json(b);
        }
        match req.send() {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().unwrap_or_default();
                if !status.is_success() {
                    return Err(format!("HTTP {}: {}", status.as_u16(), text));
                }
                if text.is_empty() {
                    return Ok((JsonValue::Null, base.clone()));
                }
                let value = serde_json::from_str(&text)
                    .map_err(|e| format!("decode: {} (body: {})", e, text))?;
                return Ok((value, base.clone()));
            }
            Err(e) => {
                last_err = format!("{base}: {e}");
                if is_pre_response_error(&e) && i < last {
                    continue;
                }
                return Err(last_err);
            }
        }
    }
    Err(last_err)
}

async fn request_api(
    state: &tauri::State<'_, AppState>,
    s: Settings,
    method: reqwest::Method,
    path_and_query: String,
    body: Option<JsonValue>,
) -> Result<JsonValue, String> {
    let cached = state.active_api_base.lock().unwrap().clone();
    let result = spawn_blocking_result(move || {
        request_api_blocking(s, method, path_and_query, body, cached)
    })
    .await;

    match result {
        Ok((value, active_base)) => {
            *state.active_api_base.lock().unwrap() = Some(active_base);
            Ok(value)
        }
        Err(e) => {
            *state.active_api_base.lock().unwrap() = None;
            Err(e)
        }
    }
}

fn settings_snapshot(state: &AppState) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// Validate a broker token (owner broker_id OR member access token) through the
/// two-base failover (RU bridge → origin). The auth gate previously hit the
/// origin with a raw `fetch`, which is blocked on RF ISPs / iOS WKWebView →
/// lock-out (BUG-C1). Routing it through `request_api` means RF/iOS users
/// validate via the RU bridge. Public endpoint: the token goes in the query,
/// not the bearer. Returns the server's validate JSON (200 `{ok:false}` for an
/// unknown/revoked token, `{ok:true,active:false}` for an expired trial); `Err`
/// only on a genuine network/HTTP failure — the JS caller maps these to the
/// `invalid` / `expired` / `network` reasons.
#[tauri::command]
async fn validate_broker_token(
    state: tauri::State<'_, AppState>,
    token: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/broker-auth/validate?token={}", token.trim());
    request_api(&state, s, reqwest::Method::GET, path, None).await
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
        return Err(
            "Recipient list is empty — add recipients in Settings → Circular email.".into(),
        );
    }

    let from: Mailbox = if smtp.from_name.is_empty() {
        smtp.from_email
            .parse()
            .map_err(|e| format!("from_email parse: {e}"))?
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
            Err(e) => {
                last_err = Some(format!("bad recipient {to}: {e}"));
                continue;
            }
        };
        let email = match Message::builder()
            .from(from.clone())
            .to(to_mb)
            .subject(subject)
            .header(header::ContentType::TEXT_PLAIN)
            .body(body_text.to_string())
        {
            Ok(m) => m,
            Err(e) => {
                last_err = Some(format!("build {to}: {e}"));
                continue;
            }
        };
        match transport.send(&email) {
            Ok(_) => {
                sent += 1;
            }
            Err(e) => {
                last_err = Some(format!("send {to}: {e}"));
            }
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
async fn register_broker(
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
    let resp = request_api(
        &state,
        s.clone(),
        reqwest::Method::POST,
        "/api/brokers".to_string(),
        Some(body),
    )
    .await?;
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
async fn publish_cargo(
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
    request_api(
        &state,
        s,
        reqwest::Method::POST,
        "/api/cargo-listings".to_string(),
        Some(body),
    )
    .await
}

#[tauri::command]
async fn publish_tonnage(
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
    request_api(
        &state,
        s,
        reqwest::Method::POST,
        "/api/tonnage-listings".to_string(),
        Some(body),
    )
    .await
}

#[tauri::command]
async fn update_cargo(
    state: tauri::State<'_, AppState>,
    listing_id: String,
    patch: JsonValue,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let mut body = patch;
    body["broker_id"] = JsonValue::String(s.broker_id.clone());
    let path = format!("/api/cargo-listings/{}", listing_id);
    request_api(&state, s, reqwest::Method::PATCH, path, Some(body)).await
}

#[tauri::command]
async fn update_tonnage(
    state: tauri::State<'_, AppState>,
    listing_id: String,
    patch: JsonValue,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let mut body = patch;
    body["broker_id"] = JsonValue::String(s.broker_id.clone());
    let path = format!("/api/tonnage-listings/{}", listing_id);
    request_api(&state, s, reqwest::Method::PATCH, path, Some(body)).await
}

#[tauri::command]
async fn fetch_my_cargo(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/cargo-listings?broker_id={}", s.broker_id);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Browse all active bazaar signals on one side — feeds the
/// «🛒 Сигналы» tab.
#[tauri::command]
async fn fetch_bazaar_signal_list(
    state: tauri::State<'_, AppState>,
    kind: String,
    limit: Option<u32>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let k = if kind == "tonnage" { "tonnage" } else { "cargo" };
    let lim = limit.unwrap_or(500);
    let path = format!("/api/bazaar/{}-signals?limit={}", k, lim);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Mail: list cached messages from broker@ inbox, optionally filtered by
/// channel (drybulk | info | broker | all=None).
#[tauri::command]
async fn fetch_mail_inbox(
    state: tauri::State<'_, AppState>,
    folder: Option<String>,
    channel: Option<String>,
    limit: Option<u32>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let f = folder.unwrap_or_else(|| "INBOX".to_string());
    let lim = limit.unwrap_or(100);
    let path = match channel.as_deref() {
        Some(c) if c != "all" => format!("/api/mail/messages?folder={}&channel={}&limit={}", f, c, lim),
        _ => format!("/api/mail/messages?folder={}&limit={}", f, lim),
    };
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Mail: fetch one message body by id.
#[tauri::command]
async fn fetch_mail_message(
    state: tauri::State<'_, AppState>,
    message_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/mail/messages/{}", message_id);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Mail: delete one cached message (server-side cache only — IMAP untouched).
/// T3a: was a raw `fetch(... DELETE)` to the origin → blocked on RF/iOS. Routed
/// through the two-base failover. Mirrors `fetch_mail_message`'s raw-id path
/// (mail ids are server-generated and URL-safe — the GET command above relies
/// on the same, so behaviour is preserved). Bearer is injected by request_api.
#[tauri::command]
async fn delete_mail_message(
    state: tauri::State<'_, AppState>,
    message_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/mail/messages/{}", message_id);
    request_api(&state, s, reqwest::Method::DELETE, path, None).await
}

/// Mail: per-channel signal-conversion counts for the ⚓/🚢 badges (T3a:
/// was a raw `fetch` to origin without failover → empty badges on RF).
#[tauri::command]
async fn fetch_mail_signal_counts(
    state: tauri::State<'_, AppState>,
    days: i64,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/mail/signal-counts?days={}", days);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Analytics: aggregated cargo flows for the «Грузопотоки» map (T3a: was a raw
/// `fetch` to origin → empty map on RF). Routed through the failover.
#[tauri::command]
async fn fetch_analytics_flows(
    state: tauri::State<'_, AppState>,
    days: i64,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/analytics/flows?days={}", days);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Mail: trigger immediate IMAP poll (refresh).
#[tauri::command]
async fn poll_mail(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    request_api(&state, s, reqwest::Method::POST, "/api/mail/poll".to_string(), None).await
}

/// Mail: send via drybulk@ — SMTP through server.
#[tauri::command]
async fn send_mail(
    state: tauri::State<'_, AppState>,
    to: String,
    cc: Option<String>,
    subject: String,
    body: String,
    in_reply_to: Option<String>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let body_json = serde_json::json!({
        "to": to,
        "cc": cc.unwrap_or_default(),
        "subject": subject,
        "body": body,
        "in_reply_to": in_reply_to,
    });
    request_api(&state, s, reqwest::Method::POST, "/api/mail/send".to_string(), Some(body_json)).await
}

/// Counterpart behavioral flags map (domain → list of flags).
/// Server computes auto-flags from bazaar dedup + counterpart CRM
/// (spammer / multi-persona / sanctions exposure / wa-first etc.)
/// Cached server-side 5 min; client refetches per view-open.
#[tauri::command]
async fn fetch_counterpart_flags(
    state: tauri::State<'_, AppState>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    request_api(&state, s, reqwest::Method::GET, "/api/counterparts/flags".to_string(), None).await
}

/// Duplicate clusters of bazaar signals — feeds the 🔍 Дедупликатор
/// tab. Server-side clusters cargo (or tonnage) signals by content
/// similarity (cargo_type+qty±10%+ports+laycan, or IMO/type+dwt±5%
/// for tonnage); each cluster surfaces the canonical (earliest) signal
/// and all duplicate copies, with a strength tag canonical / duplicate
/// / heavy-spam.
#[tauri::command]
async fn fetch_duplicate_clusters(
    state: tauri::State<'_, AppState>,
    kind: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let k = if kind == "tonnage" { "tonnage" } else { "cargo" };
    let path = format!("/api/bazaar/duplicate-clusters?kind={}&only_with_dups=true", k);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Bazaar × bazaar matches — opposite-side bazaar signals that the
/// engine paired with the given signal (universal, no broker scoping).
#[tauri::command]
async fn fetch_bazaar_cross_matches(
    state: tauri::State<'_, AppState>,
    signal_kind: String,
    signal_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let kind = if signal_kind == "tonnage" { "tonnage" } else { "cargo" };
    let path = format!("/api/bazaar-signals/{}/{}/matches?limit=200", kind, signal_id);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// List ALL bazaar×bazaar pairs (cargo signal ↔ tonnage signal) — used as
/// the source for the "Совпадения" tab's col 2 so rows are actual pairs,
/// not single signals with a "1 match" badge.
#[tauri::command]
async fn fetch_bazaar_pairs(
    state: tauri::State<'_, AppState>,
    days: Option<u32>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let d = days.unwrap_or(2).clamp(1, 365);
    let path = format!("/api/bazaar-pairs?limit=300&max_age_days={}", d);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Vessel DB lookup — full card (details, Skipi scores, managers,
/// seafarer review aggregates) for the in-app vessel card.
#[tauri::command]
async fn fetch_vessel(state: tauri::State<'_, AppState>, imo: u64) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    request_api(&state, s, reqwest::Method::GET, format!("/api/vessels/{}", imo), None).await
}

fn pct_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// Resolve a vessel name from a bazaar signal against the vessel DB —
/// signals usually carry a name without IMO.
#[tauri::command]
async fn search_vessels(state: tauri::State<'_, AppState>, q: String) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/vessels/search?q={}&limit=8", pct_encode(q.trim()));
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// MarineTraffic mini-browser — last known position without leaving the
/// app. Same dedicated-window pattern as open_wa_chat: reuse + renavigate
/// if already open. By IMO when known, by name search otherwise.
#[tauri::command]
fn open_marinetraffic(app: tauri::AppHandle, imo: Option<String>, name: Option<String>) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let imo_digits = imo
        .map(|i| i.chars().filter(|c| c.is_ascii_digit()).collect::<String>())
        .filter(|d| d.len() >= 6);
    let url = if let Some(d) = imo_digits {
        format!("https://www.marinetraffic.com/en/ais/details/ships/imo:{}", d)
    } else if let Some(n) = name.map(|n| n.trim().to_uppercase()).filter(|n| !n.is_empty()) {
        format!("https://www.marinetraffic.com/en/ais/home/shipname:{}", pct_encode(&n))
    } else {
        return Err("нет ни IMO, ни имени судна".into());
    };

    if let Some(win) = app.get_webview_window("marinetraffic") {
        let _ = win.eval(&format!("window.location.href = '{}';", url));
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(
        &app,
        "marinetraffic",
        WebviewUrl::External(reqwest::Url::parse(&url).map_err(|e| e.to_string())?),
    )
    .title("MarineTraffic — Skipi Broker")
    .inner_size(1150.0, 820.0)
    .min_inner_size(640.0, 420.0)
    .resizable(true)
    .build()
    .map(|_| ())
    .map_err(|e| format!("open MarineTraffic window: {e}"))
}

/// Team presence: heartbeat while the team chat polls + member list
/// for the «Команда» module (online dots).
#[tauri::command]
async fn ping_team_presence(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let nick = if s.team_nickname.trim().is_empty() {
        s.display_name.clone()
    } else {
        s.team_nickname.clone()
    };
    let body = serde_json::json!({
        "broker_id": s.broker_id,
        "nickname": nick,
        "app_version": env!("CARGO_PKG_VERSION"),
    });
    request_api(&state, s, reqwest::Method::POST, "/api/team/presence".to_string(), Some(body)).await
}

#[tauri::command]
async fn fetch_team_members(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/team/members?broker_id={}", s.broker_id);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Case seeds — дела, созданные удалённо (LLM-ассистент из чата или
/// админ). Клиент подхватывает их в локальный модуль Дела (dedup по id).
#[tauri::command]
async fn fetch_case_seeds(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/case-seeds?broker_id={}", s.broker_id);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// Brokerage counterparts CRM — full profile list synced from freight_agent's
/// competitor_profiles.csv. Used by the Контрагенты tab to enrich the local
/// signal-derived aggregation with role, top_cargoes/routes, commission, etc.
#[tauri::command]
async fn fetch_counterparts(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    request_api(&state, s, reqwest::Method::GET, "/api/counterparts?limit=1000".to_string(), None).await
}

#[tauri::command]
async fn fetch_my_tonnage(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/tonnage-listings?broker_id={}", s.broker_id);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

#[tauri::command]
async fn fetch_matches(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches?broker_id={}", s.broker_id);
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

/// 4-panel UX inbox: returns own × own + own × bazaar matches with
/// embedded signal payloads. When `listing_id` is set, scope to a
/// single P1 row's match feed. Empty `listing_id` returns the full
/// queue across all of the broker's listings.
#[tauri::command]
async fn fetch_matches_inbox(
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
    request_api(&state, s, reqwest::Method::GET, path, None).await
}

#[tauri::command]
async fn mark_bazaar_match_seen(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/seen", match_id);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn dismiss_bazaar_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/dismiss", match_id);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn pin_bazaar_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/pin", match_id);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn unpin_bazaar_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/bazaar-matches/{}/unpin", match_id);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn engage_listing(
    state: tauri::State<'_, AppState>,
    kind: String,
    listing_id: String,
    action: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let endpoint = if kind == "cargo" {
        "cargo-listings"
    } else {
        "tonnage-listings"
    };
    let path = format!("/api/{}/{}/engage", endpoint, listing_id);
    let body = serde_json::json!({
        "viewer_broker_id": s.broker_id,
        "action": action,
    });
    request_api(&state, s, reqwest::Method::POST, path, Some(body)).await
}

#[tauri::command]
async fn close_listing(
    state: tauri::State<'_, AppState>,
    kind: String,
    listing_id: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let endpoint = if kind == "cargo" {
        "cargo-listings"
    } else {
        "tonnage-listings"
    };
    let path = format!("/api/{}/{}/close", endpoint, listing_id);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn mark_match_seen(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches/{}/seen?side={}", match_id, side);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn send_circular_email(
    state: tauri::State<'_, AppState>,
    subject: String,
    body: String,
) -> Result<usize, String> {
    let s = settings_snapshot(&state);
    spawn_blocking_result(move || send_smtp_circular(&s.smtp, &s.recipients, &subject, &body)).await
}

// ---------- Team chat (operators sharing one broker_id) ----------

#[tauri::command]
async fn send_team_message_with_llm(
    state: tauri::State<'_, AppState>,
    body: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Empty message.".into());
    }
    let nickname = if !s.team_nickname.trim().is_empty() {
        s.team_nickname.trim().to_string()
    } else if !s.display_name.trim().is_empty() {
        s.display_name.trim().to_string()
    } else {
        "anon".to_string()
    };
    let payload = serde_json::json!({
        "broker_id": s.broker_id,
        "sender_nickname": nickname,
        "body": trimmed,
        "trigger_llm": true,
    });
    request_api(
        &state,
        s,
        reqwest::Method::POST,
        "/api/team/messages".to_string(),
        Some(payload),
    )
    .await
}

#[tauri::command]
async fn send_team_message(
    state: tauri::State<'_, AppState>,
    body: String,
    event_type: Option<String>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err("Empty message.".into());
    }
    let nickname = if !s.team_nickname.trim().is_empty() {
        s.team_nickname.trim().to_string()
    } else if !s.display_name.trim().is_empty() {
        s.display_name.trim().to_string()
    } else {
        "anon".to_string()
    };
    let mut payload = serde_json::json!({
        "broker_id": s.broker_id,
        "sender_nickname": nickname,
        "body": trimmed,
    });
    if let Some(et) = event_type
        .as_deref()
        .map(str::trim)
        .filter(|x| !x.is_empty())
    {
        payload["event_type"] = JsonValue::String(et.to_string());
    }
    request_api(
        &state,
        s,
        reqwest::Method::POST,
        "/api/team/messages".to_string(),
        Some(payload),
    )
    .await
}

#[tauri::command]
async fn fetch_team_messages(
    state: tauri::State<'_, AppState>,
    since: Option<String>,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    if s.broker_id.is_empty() {
        return Err("Broker not registered — open Settings and register first.".into());
    }
    let mut path = format!("/api/team/messages?broker_id={}", s.broker_id);
    if let Some(ts) = since.as_deref().map(str::trim).filter(|x| !x.is_empty()) {
        // ISO timestamps may carry `+` (e.g. `+00:00`) which a raw
        // query string would decode as space — percent-encode the
        // whole value to keep FastAPI's datetime parser happy.
        path.push_str(&format!("&since={}", url_percent_encode(ts)));
    }
    request_api(&state, s, reqwest::Method::GET, path, None).await
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
    // On desktop, hand off to the OS via xdg-open / open / start. On
    // Android/iOS this Rust path never runs — the JS layer should use
    // tauri-plugin-opener or platform Intent APIs instead.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        use std::process::Command;
        #[cfg(target_os = "linux")]
        let result = Command::new("xdg-open").arg(target).spawn();
        #[cfg(target_os = "macos")]
        let result = Command::new("open").arg(target).spawn();
        #[cfg(target_os = "windows")]
        let result = Command::new("cmd")
            .args(["/C", "start", "", target])
            .spawn();
        return result.map(|_| ()).map_err(|e| format!("open failed: {e}"));
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = target;
        Err("open_path_or_url unsupported on mobile".to_string())
    }
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
        return Err(
            "Reply-to email not set — open Settings and configure your address first.".into(),
        );
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
    path.push(format!(
        "skipi-broker-{}-{}.eml",
        stamp,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&path, eml).map_err(|e| format!("write .eml: {e}"))?;

    open_path_or_url(path.to_string_lossy().as_ref())?;
    Ok(path.to_string_lossy().to_string())
}

/// Compose a CIRCULAR .eml for an email blast: To = the broker themselves,
/// Bcc = the whole recipient list (so recipients never see each other —
/// the professional way to circulate a position). Writes + hands off to
/// the OS mail client, same as generate_eml. The user reviews and sends.
#[tauri::command]
fn circulate_eml(
    state: tauri::State<'_, AppState>,
    recipients: Vec<String>,
    subject: String,
    body: String,
) -> Result<String, String> {
    let s = settings_snapshot(&state);
    if s.reply_to.is_empty() {
        return Err(
            "Reply-to email not set — open Settings and configure your address first.".into(),
        );
    }
    let bcc = recipients
        .iter()
        .map(|r| r.trim())
        .filter(|r| !r.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if bcc.is_empty() {
        return Err("Список рассылки пуст — добавь хотя бы один email.".into());
    }
    let from_header = if s.display_name.is_empty() {
        s.reply_to.clone()
    } else {
        format!("{} <{}>", s.display_name, s.reply_to)
    };
    let body_with_footer = format!("{}\n\n--\nSent via Skipi", body);
    let eml = format!(
        "Date: {date}\r\n\
         From: {from}\r\n\
         To: {to}\r\n\
         Bcc: {bcc}\r\n\
         Subject: {subject}\r\n\
         MIME-Version: 1.0\r\n\
         Content-Type: text/plain; charset=UTF-8\r\n\
         Content-Transfer-Encoding: 8bit\r\n\
         X-Skipi-Channel: eml-circular\r\n\
         \r\n\
         {body}\r\n",
        date = rfc822_now(),
        from = from_header,
        to = s.reply_to,
        bcc = bcc,
        subject = subject,
        body = body_with_footer,
    );
    let mut path = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "no writable home dir".to_string())?;
    path.push("skipi-broker");
    path.push("drafts");
    std::fs::create_dir_all(&path).map_err(|e| format!("mkdir drafts: {e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    path.push(format!(
        "skipi-circular-{}-{}.eml",
        stamp,
        uuid::Uuid::new_v4().simple()
    ));
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

/// Open (or refocus + re-navigate) a dedicated WhatsApp Web window
/// pinned to the conversation with the given phone. CSS is injected to
/// hide WA Web's sidebar/header so only the active chat is visible —
/// the broker stays in single-counterparty mode instead of the full
/// WA UI distracting from the deal in hand.
///
/// First run requires QR-code scan (one-time per Tauri WebKit profile).
#[tauri::command]
fn open_wa_chat(app: tauri::AppHandle, phone: String) -> Result<(), String> {
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 6 {
        return Err("Не похоже на телефон — нужны минимум 6 цифр.".into());
    }
    let url = format!("https://web.whatsapp.com/send?phone={}", digits);

    // Reuse the existing window if open — just navigate it to the new chat.
    if let Some(win) = app.get_webview_window("wa-chat") {
        let _ = win.eval(&format!(
            "if (window.location.pathname !== '/send' || !window.location.search.includes('phone={d}')) {{ window.location.href = '{u}'; }}",
            d = digits, u = url
        ));
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }

    let injection = r#"
(function(){
    var css = "\
        [data-testid='chatlist-pane'], #side, \
        header._3xysY, header.app-wrapper-web-header, \
        ._2Ts6i, ._3RGKj, ._3xRSL, \
        [data-testid='chatlist-header'], [data-testid='chatlist-search'] \
            { display: none !important; } \
        #main { left: 0 !important; width: 100% !important; } \
        ._3WByx, ._2QgSC, [data-testid='conversation-panel-wrapper'] \
            { width: 100% !important; left: 0 !important; }";
    function inject(){
        if(document.getElementById('skipi-wa-style')) return;
        var s = document.createElement('style');
        s.id = 'skipi-wa-style';
        s.textContent = css;
        document.head.appendChild(s);
    }
    if(document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject);
    // WA Web mutates DOM heavily during load — reinject for ~30s.
    var n = 0;
    var iv = setInterval(function(){ inject(); if(++n > 60) clearInterval(iv); }, 500);
})();
"#;

    WebviewWindowBuilder::new(
        &app,
        "wa-chat",
        WebviewUrl::External(reqwest::Url::parse(&url).map_err(|e| e.to_string())?),
    )
    .title("WhatsApp — Skipi Broker")
    .inner_size(720.0, 900.0)
    .min_inner_size(420.0, 600.0)
    .resizable(true)
    .initialization_script(injection)
    .build()
    .map(|_| ())
    .map_err(|e| format!("open WA window: {e}"))
}

#[tauri::command]
async fn dismiss_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches/{}/dismiss?side={}", match_id, side);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn pin_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches/{}/pin?side={}", match_id, side);
    request_api(&state, s, reqwest::Method::POST, path, None).await
}

#[tauri::command]
async fn unpin_match(
    state: tauri::State<'_, AppState>,
    match_id: String,
    side: String,
) -> Result<JsonValue, String> {
    let s = settings_snapshot(&state);
    let path = format!("/api/matches/{}/unpin?side={}", match_id, side);
    request_api(&state, s, reqwest::Method::POST, path, None).await
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
async fn request_agent_update(state: tauri::State<'_, AppState>) -> Result<JsonValue, String> {
    use std::process::Command;

    let agent_dir = std::path::Path::new("/home/linux/scripts");
    let venv_python = agent_dir.join("venv/bin/python");
    if !venv_python.exists() {
        // Agent isn't on this install (Sasha's Windows etc.). Soft-fail:
        // return success with zero counts and a remote flag — frontend
        // will still trigger refreshInbox(), so the click is useful
        // (pulls whatever the server-side auto-adopt has produced).
        return Ok(serde_json::json!({
            "cargo_inserted": 0,
            "tonnage_inserted": 0,
            "matches_created": 0,
            "remote_only": true,
            "raw_last_line": "agent not local; data refreshed from server"
        }));
    }

    // Push targets the same backend the broker app currently talks to.
    // Previously this was hardcoded to 127.0.0.1:8000, which is fine for
    // local dev but produces "no new signals" the moment the app is
    // pointed at prod (api.skipi.app) — bazaar_push wrote into local
    // while the app read from prod.
    let s = settings_snapshot(&state);
    let output = spawn_blocking_result(move || {
        let url = s.server_url.trim_end_matches('/').to_string();
        let targets_prod =
            url.is_empty() || url.contains("api.skipi.app") || url.contains("api-ru.skipi.app");

        // Spawn the right script. The PROD path goes through the shell
        // wrapper that swaps in `bazaar_state.prod.json` so it doesn't
        // collide with the local cursor.
        if targets_prod {
            let prod_script = agent_dir.join("freight_agent/bazaar_push_prod.sh");
            if !prod_script.exists() {
                return Err("Prod push скрипт не найден на этой машине.".into());
            }
            Command::new("bash")
                .arg(&prod_script)
                .current_dir(agent_dir)
                .env_remove("PYTHONHOME")
                .env_remove("PYTHONPATH")
                .env_remove("PYTHONSTARTUP")
                .env_remove("PYTHONNOUSERSITE")
                .env_remove("LD_LIBRARY_PATH")
                .env_remove("LD_PRELOAD")
                .env_remove("PERLLIB")
                .env_remove("GTK_DATA_PREFIX")
                .env_remove("GTK_EXE_PREFIX")
                .env_remove("GTK_PATH")
                .env_remove("GDK_PIXBUF_MODULEDIR")
                .env_remove("GDK_PIXBUF_MODULE_FILE")
                .env_remove("GI_TYPELIB_PATH")
                .env_remove("XDG_DATA_DIRS")
                .output()
                .map_err(|e| format!("spawn agent (prod) failed: {e}"))
        } else {
            // Local dev — push to whatever Settings.server_url points at.
            // Never bake a real admin token into the binary (BUG-L9 / T7). Read it
            // from the env at runtime; empty if unset (the dev-only push then no-ops).
            let admin_token = std::env::var("SKIPI_ADMIN_TOKEN").unwrap_or_default();
            Command::new(&venv_python)
                .args(["-m", "freight_agent.bazaar_push"])
                .current_dir(agent_dir)
                .env_remove("PYTHONHOME")
                .env_remove("PYTHONPATH")
                .env_remove("PYTHONSTARTUP")
                .env_remove("PYTHONNOUSERSITE")
                .env_remove("LD_LIBRARY_PATH")
                .env_remove("LD_PRELOAD")
                .env_remove("PERLLIB")
                .env_remove("GTK_DATA_PREFIX")
                .env_remove("GTK_EXE_PREFIX")
                .env_remove("GTK_PATH")
                .env_remove("GDK_PIXBUF_MODULEDIR")
                .env_remove("GDK_PIXBUF_MODULE_FILE")
                .env_remove("GI_TYPELIB_PATH")
                .env_remove("XDG_DATA_DIRS")
                .env("SKIPI_BAZAAR_URL", &url)
                .env("SKIPI_ADMIN_TOKEN", &admin_token)
                .output()
                .map_err(|e| format!("spawn agent (local) failed: {e}"))
        }
    })
    .await?;

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
            let end = rest
                .find(|c: char| !c.is_ascii_digit() && c != '/')
                .unwrap_or(rest.len());
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // opener: cross-platform — on Android it hands mailto:/https: to the
        // OS Intent system (the mobile circulate-by-email path uses this).
        .plugin(tauri_plugin_opener::init());
    // updater + process are desktop-only — Tauri mobile uses platform stores
    // for updates and has no process-relaunch concept on Android/iOS.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    builder
        .manage(AppState {
            settings: Mutex::new(Settings::load()),
            active_api_base: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            register_broker,
            validate_broker_token,
            publish_cargo,
            publish_tonnage,
            update_cargo,
            update_tonnage,
            fetch_my_cargo,
            fetch_my_tonnage,
            fetch_bazaar_cross_matches,
            fetch_bazaar_pairs,
            fetch_case_seeds,
            ping_team_presence,
            fetch_team_members,
            fetch_vessel,
            search_vessels,
            open_marinetraffic,
            fetch_counterparts,
            fetch_bazaar_signal_list,
            fetch_duplicate_clusters,
            fetch_counterpart_flags,
            fetch_mail_inbox,
            fetch_mail_message,
            delete_mail_message,
            fetch_mail_signal_counts,
            fetch_analytics_flows,
            poll_mail,
            send_mail,
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
            send_team_message,
            send_team_message_with_llm,
            fetch_team_messages,
            generate_eml,
            circulate_eml,
            open_whatsapp,
            open_wa_chat,
            open_external,
            feedback::init_app_diagnostics,
            feedback::app_heartbeat,
            feedback::mark_app_shutdown,
            feedback::record_app_diagnostic,
            feedback::get_feedback_prompt_state,
            feedback::postpone_app_feedback,
            feedback::submit_app_feedback,
            feedback::list_app_feedback,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
