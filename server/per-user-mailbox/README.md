# Per-user mailbox — backend (skipi-server) change set

Feature branch: `feature/per-user-mailbox`. This directory is a **review mirror**
of the backend changes deployed to `skipi-server` on Contabo
(`/opt/skipi-server`, root via `~/.ssh/contabo_maritime`). The server git tree
keeps a long-standing set of intentional **uncommitted** prod changes
(`config.py`, `main.py`, `models.py`), so to avoid entangling with those, the
backend is deployed by `scp` + service restart and tracked here instead of
committed on the server. Every edited server file has a timestamped
`*.bak.premailbox-<ts>` backup beside it for rollback.

## Deployment facts
- **Deployed:** 2026-06-22, server backups stamped `*.bak.premailbox-20260621-220620`
  (server TZ UTC+2); migration applied + `skipi-server` restarted same session.
- **Migration revision:** `e4b2f9a1c7d6` (down_revision `7d2b1f9c4a6e`). `alembic current` = head.
- **New runtime dependency:** `cryptography==49.0.0` (installed into `/opt/skipi-server/.venv`).
- **.env variables required (names only — NO values in git):**
  - `MAILBOX_SECRET_KEY` — urlsafe-b64 Fernet key (32 bytes). Generate with
    `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`.
    Already set on the live server; `.env` backed up to `.env.bak.premailbox-*`.
    **Back this key up** — losing it makes stored mailbox passwords undecryptable.

## What changed (deployed 2026-06-22)

New files (full copies here):
- `app/mail_crypto.py` — Fernet wrapper over `MAILBOX_SECRET_KEY` (encrypt/decrypt
  mailbox passwords; never logs/returns plaintext).
- `app/routers/mail.py` — rewritten: principal-scoped per-user mailbox endpoints.
- `alembic/versions/e4b2f9a1c7d6_per_user_mailbox.py` — migration extending
  `mail_accounts` (down_revision = `7d2b1f9c4a6e`, the prior head).

Modified files (unified diffs vs the pre-edit backup in `patches/`):
- `patches/config.py.diff` — add `mailbox_secret_key` setting.
- `patches/models.py.diff` — extend `MailAccount` (principal_id/kind, username,
  secret_ciphertext, imap/smtp_security, reply_to, provider, status, last_error,
  extract_to_bazaar; unique index on principal_id).
- `patches/mail_service.py.diff` — `config_from_account()`, `test_account_login()`,
  and `upsert_messages(..., extract_to_bazaar=False)` (privacy gate); legacy
  drybulk poller now passes `extract_to_bazaar=True`.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/mail/mailbox`      | status for current principal (masked email, never password) |
| PUT    | `/api/mail/mailbox`      | create/replace config; password write-only |
| POST   | `/api/mail/mailbox/test` | live IMAP+SMTP login check (no persistence) |
| DELETE | `/api/mail/mailbox`      | disconnect: delete creds + purge that principal's cached messages |

Existing `/api/mail/{messages,messages/{id},poll,send,signal-counts}` now resolve
the principal and operate **only** on that principal's `account_id`; no mailbox ⇒
`not_configured`. `signal-counts` now requires auth.

## Principal model
- owner  → `brokers.id` (bearer is the broker_id)
- member → `broker_access_tokens.id` (bearer is an active token)
- `mail_accounts.principal_id` is unique → one mailbox per principal.
- `mail_accounts.id` (== `mail_messages.account_id`) = `"acct-"+sha1(principal_id)[:24]`.

## Security
- `MAILBOX_SECRET_KEY` (Fernet) added to `/opt/skipi-server/.env` (backup
  `.env.bak.premailbox-*`). **Back this key up** — losing it makes all stored
  passwords undecryptable (users must re-enter).
- `cryptography==49.0.0` installed into `/opt/skipi-server/.venv`.
- Passwords stored as Fernet ciphertext (opaque urlsafe token); never logged, never returned.

## Privacy
- Per-user mailboxes default `extract_to_bazaar=false` → polled personal mail is
  NOT auto-published into the global bazaar. Only the legacy drybulk account opts in.

## Rollback
1. `scp` each `*.bak.premailbox-<ts>` back over its file; restore `.env` backup.
2. `cd /opt/skipi-server && .venv/bin/alembic downgrade 7d2b1f9c4a6e`.
3. `systemctl restart skipi-server`.

## Known / flagged
- The legacy drybulk poller (`broker@capt-tymur.com`) has been failing
  `AUTHENTICATIONFAILED` since 2026-06-17 — the Gmail app password is dead.
  Pre-existing, unrelated to this change; needs a fresh app password.
- Slice 1 connections are implicit-SSL (993/465). STARTTLS for custom providers
  is a documented follow-up.
- The legacy drybulk account was intentionally **not** seeded to any principal in
  this slice (no shared mailbox surfaced to users); its 579 messages remain in the
  DB but are not shown to anyone until/unless deliberately seeded.
