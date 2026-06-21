"""Per-user mailbox endpoints.

Each authenticated principal (owner = brokers.id, member =
broker_access_tokens.id) connects their OWN IMAP/SMTP mailbox. There is no
shared server mailbox for normal users: if a principal has no mail_accounts
row, every endpoint returns a clean `not_configured` response and the client
shows a "Connect your email" screen.

Credentials are stored encrypted (mail_crypto / MAILBOX_SECRET_KEY). The
password is write-only: it is accepted on PUT, never returned by GET, and
never logged.

The legacy drybulk@montlinechartering.com account stays as an internal
account (seeded to Tymur's broker_id, extract_to_bazaar=True) and keeps its
own background poller — it is NOT a fallback for users without a mailbox.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..mail_service import (
    config_from_account,
    poll_account_once,
    send_message,
    test_account_login,
    upsert_messages,
)

router = APIRouter(prefix="/api/mail", tags=["mail"])


# --------------------------------------------------------------------------
# Principal resolution + helpers
# --------------------------------------------------------------------------
async def resolve_principal(authorization: str | None, db: AsyncSession) -> tuple[str, str]:
    """Map the bearer token to a stable principal.

    owner  → (broker_id, 'owner')           bearer is a brokers.id
    member → (access_token.id, 'member')    bearer is an active broker_access_tokens.token

    Raises 401 (missing) / 403 (unknown). Admin token is intentionally NOT a
    mailbox principal — ops tooling has no personal mailbox.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "missing bearer")
    raw = authorization.split(" ", 1)[1].strip()
    if not raw or len(raw) > 64:
        raise HTTPException(403, "bad token")
    from ..models import Broker, BrokerAccessToken
    broker = await db.get(Broker, raw)
    if broker is not None:
        return raw, "owner"
    tok = (await db.execute(
        select(BrokerAccessToken).where(
            BrokerAccessToken.token == raw,
            BrokerAccessToken.status == "active",
        )
    )).scalar_one_or_none()
    if tok is not None:
        return tok.id, "member"
    raise HTTPException(403, "bad token")


def _account_id_for(principal_id: str) -> str:
    """Deterministic mail_accounts.id (== mail_messages.account_id) for a principal."""
    return "acct-" + hashlib.sha1(principal_id.encode()).hexdigest()[:24]


async def _get_account(db: AsyncSession, principal_id: str):
    from ..models import MailAccount
    return (await db.execute(
        select(MailAccount).where(MailAccount.principal_id == principal_id)
    )).scalar_one_or_none()


def _mask_email(addr: str | None) -> str:
    if not addr or "@" not in addr:
        return addr or ""
    local, _, dom = addr.partition("@")
    if len(local) <= 2:
        masked = (local[0] if local else "") + "*"
    else:
        masked = local[0] + ("*" * (len(local) - 2)) + local[-1]
    return f"{masked}@{dom}"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# Mailbox config CRUD (status / connect / test / disconnect)
# --------------------------------------------------------------------------
@router.get("/mailbox")
async def get_mailbox(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Current principal's mailbox status. Never returns the password."""
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        return {"configured": False, "status": "not_configured"}
    return {
        "configured": True,
        "status": acc.status or "active",
        "email_masked": _mask_email(acc.address),
        "display_name": acc.display_name,
        "provider": acc.provider,
        "imap_host": acc.imap_host,
        "imap_port": acc.imap_port,
        "imap_security": acc.imap_security or "ssl",
        "smtp_host": acc.smtp_host,
        "smtp_port": acc.smtp_port,
        "smtp_security": acc.smtp_security or "ssl",
        "username_masked": _mask_email(acc.username or acc.address),
        "reply_to": acc.reply_to,
        "has_password": bool(acc.secret_ciphertext),
        "extract_to_bazaar": bool(acc.extract_to_bazaar),
        "last_poll_at": acc.last_poll_at.isoformat() if acc.last_poll_at else None,
        "last_error": acc.last_error,
    }


@router.put("/mailbox")
async def put_mailbox(
    payload: dict,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Create or replace the current principal's mailbox config.

    Password is write-only: present ⇒ (re-)encrypt and store; omitted ⇒ keep
    the existing one (required on first save).
    """
    principal_id, kind = await resolve_principal(authorization, db)

    address = (payload.get("address") or "").strip().lower()
    imap_host = (payload.get("imap_host") or "").strip()
    smtp_host = (payload.get("smtp_host") or "").strip()
    if not address or "@" not in address:
        raise HTTPException(422, "valid address required")
    if not imap_host or not smtp_host:
        raise HTTPException(422, "imap_host and smtp_host required")

    password = payload.get("password")  # write-only
    from ..mail_crypto import crypto_available, encrypt_secret
    from ..models import MailAccount

    acc = await _get_account(db, principal_id)
    is_new = acc is None
    if is_new:
        acc = MailAccount(
            id=_account_id_for(principal_id),
            principal_id=principal_id,
            principal_kind=kind,
            created_at=_utcnow(),
            extract_to_bazaar=False,
        )
        db.add(acc)

    acc.address = address
    acc.username = (payload.get("username") or address).strip()
    disp = (payload.get("from_name") or payload.get("display_name") or "").strip()
    acc.display_name = disp or None
    acc.imap_host = imap_host
    acc.imap_port = int(payload.get("imap_port") or 993)
    acc.imap_security = (payload.get("imap_security") or "ssl").strip().lower()
    acc.smtp_host = smtp_host
    acc.smtp_port = int(payload.get("smtp_port") or 465)
    acc.smtp_security = (payload.get("smtp_security") or "ssl").strip().lower()
    acc.reply_to = (payload.get("reply_to") or "").strip() or None
    acc.provider = (payload.get("provider") or "custom").strip().lower()
    if acc.extract_to_bazaar is None:
        acc.extract_to_bazaar = False  # personal mailboxes never auto-publish (slice 1)
    acc.status = "active"
    acc.last_error = None

    if password:
        if not crypto_available():
            raise HTTPException(503, "credential encryption unavailable (MAILBOX_SECRET_KEY not set)")
        acc.secret_ciphertext = encrypt_secret(password)
    elif is_new:
        raise HTTPException(422, "password required for a new mailbox")

    try:
        await db.commit()
    except Exception as e:
        await db.rollback()
        # Most likely the unique(address) / unique(principal_id) constraint.
        if "unique" in str(e).lower() or "duplicate" in str(e).lower():
            raise HTTPException(409, "this email address is already connected")
        raise HTTPException(500, "could not save mailbox")
    return {
        "ok": True,
        "configured": True,
        "is_new": is_new,
        "email_masked": _mask_email(address),
        "status": "active",
    }


@router.post("/mailbox/test")
async def test_mailbox(
    payload: dict,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Test IMAP+SMTP login with the given (or stored) credentials. No persistence."""
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)

    address = (payload.get("address") or (acc.address if acc else "") or "").strip().lower()
    username = (payload.get("username") or (acc.username if acc else "") or address).strip()
    imap_host = (payload.get("imap_host") or (acc.imap_host if acc else "") or "").strip()
    imap_port = int(payload.get("imap_port") or (acc.imap_port if acc else 993))
    smtp_host = (payload.get("smtp_host") or (acc.smtp_host if acc else "") or "").strip()
    smtp_port = int(payload.get("smtp_port") or (acc.smtp_port if acc else 465))

    password = payload.get("password")
    if not password and acc and acc.secret_ciphertext:
        from ..mail_crypto import decrypt_secret
        try:
            password = decrypt_secret(acc.secret_ciphertext)
        except Exception:
            return {"ok": False, "reason": "stored credential could not be decrypted"}
    if not (address and imap_host and smtp_host and username and password):
        return {"ok": False, "reason": "missing fields (need address, imap/smtp host, username, password)"}

    from ..mail_service import MailAccountConfig
    cfg = MailAccountConfig(
        address=address, display_name=address,
        imap_host=imap_host, imap_port=imap_port, imap_user=username, imap_password=password,
        smtp_host=smtp_host, smtp_port=smtp_port, smtp_user=username, smtp_password=password,
        from_address=address, from_name=address, delivered_to_filter=address,
    )
    return await test_account_login(cfg)


@router.delete("/mailbox")
async def disconnect_mailbox(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete the principal's mailbox config AND purge its cached messages."""
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        return {"ok": True, "deleted": False, "status": "not_configured"}
    from ..models import MailAccount, MailMessage
    account_id = acc.id
    purged = (await db.execute(
        sa_delete(MailMessage).where(MailMessage.account_id == account_id)
    )).rowcount
    await db.execute(sa_delete(MailAccount).where(MailAccount.id == account_id))
    await db.commit()
    return {"ok": True, "deleted": True, "purged_messages": purged}


# --------------------------------------------------------------------------
# Message endpoints — scoped to the current principal's account
# --------------------------------------------------------------------------
@router.get("/messages")
async def list_messages(
    folder: str = Query(default="INBOX"),
    channel: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        return {"folder": folder, "messages": [], "total": 0, "status": "not_configured"}
    from ..models import MailMessage
    stmt = (
        select(MailMessage)
        .where(MailMessage.account_id == acc.id, MailMessage.folder == folder)
        .order_by(MailMessage.date_received.desc().nullslast())
        .limit(limit)
        .offset(offset)
    )
    if channel and channel != "all":
        stmt = stmt.where(MailMessage.channel == channel)
    rows = (await db.execute(stmt)).scalars().all()
    return {
        "folder": folder,
        "total": len(rows),
        "messages": [
            {
                "id": m.id, "uid": m.uid, "from": m.from_addr, "from_name": m.from_name,
                "to": m.to_addrs, "cc": m.cc_addrs, "channel": m.channel, "subject": m.subject,
                "date_received": m.date_received.isoformat() if m.date_received else None,
                "is_read": m.is_read, "is_flagged": m.is_flagged,
            }
            for m in rows
        ],
    }


@router.get("/messages/{message_id}")
async def get_message(
    message_id: str,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        raise HTTPException(404, "message not in cache")
    from ..models import MailMessage
    m = (await db.execute(
        select(MailMessage).where(
            MailMessage.id == message_id, MailMessage.account_id == acc.id
        )
    )).scalar_one_or_none()
    if not m:
        raise HTTPException(404, "message not in cache")
    return {
        "id": m.id, "folder": m.folder, "channel": m.channel, "uid": m.uid,
        "from": m.from_addr, "from_name": m.from_name, "to": m.to_addrs, "cc": m.cc_addrs,
        "subject": m.subject, "body_text": m.body_text, "body_html": m.body_html,
        "is_read": m.is_read, "is_flagged": m.is_flagged,
        "date_received": m.date_received.isoformat() if m.date_received else None,
        "attachments": m.attachments_json or [],
    }


@router.post("/poll")
async def force_poll(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Immediate IMAP poll of the current principal's mailbox (INBOX + SENT)."""
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        return {"status": "not_configured"}
    from ..mail_crypto import decrypt_secret
    try:
        password = decrypt_secret(acc.secret_ciphertext)
    except Exception:
        acc.status = "error"
        acc.last_error = "credential decrypt failed"
        await db.commit()
        return {"status": "error", "reason": "credential decrypt failed"}
    cfg = config_from_account(acc, password)

    summary = {}
    overall_status = "ok"
    overall_reason = None
    for folder in ("INBOX", "SENT"):
        result = await poll_account_once(cfg, folder=folder)
        new_added = 0
        if result.get("status") == "ok" and result.get("messages"):
            new_added = await upsert_messages(
                db, acc.id, folder, result["messages"],
                extract_to_bazaar=bool(acc.extract_to_bazaar),
            )
        if result.get("status") not in ("ok", "disabled"):
            overall_status = result.get("status") or "error"
            overall_reason = result.get("reason")
        summary[folder] = {
            "status": result.get("status"),
            "fetched": result.get("fetched", 0),
            "new_in_cache": new_added,
            "reason": result.get("reason"),
        }
    acc.last_poll_at = _utcnow()
    acc.status = "active" if overall_status == "ok" else "error"
    acc.last_error = overall_reason
    await db.commit()
    return {
        "status": overall_status,
        "reason": overall_reason,
        "folders": summary,
        "fetched": summary.get("INBOX", {}).get("fetched", 0),
        "new_in_cache": summary.get("INBOX", {}).get("new_in_cache", 0),
    }


@router.post("/send")
async def send(
    payload: dict,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """SMTP send via the current principal's own mailbox."""
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        return {"sent": False, "status": "not_configured", "reason": "no mailbox connected"}
    from ..mail_crypto import decrypt_secret
    try:
        password = decrypt_secret(acc.secret_ciphertext)
    except Exception:
        return {"sent": False, "reason": "credential decrypt failed"}
    cfg = config_from_account(acc, password)

    to = payload.get("to") or []
    if isinstance(to, str):
        to = [t.strip() for t in to.split(",") if t.strip()]
    cc = payload.get("cc") or []
    if isinstance(cc, str):
        cc = [t.strip() for t in cc.split(",") if t.strip()]
    return await send_message(
        cfg,
        to_addrs=to,
        cc_addrs=cc,
        subject=payload.get("subject", ""),
        body_text=payload.get("body", ""),
        in_reply_to=payload.get("in_reply_to"),
    )


@router.get("/signal-counts")
async def signal_counts(
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
    days: int = 14,
) -> dict:
    """Per-mail signal-conversion counts, scoped to the principal's account."""
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        return {}
    sql = text(
        """
        WITH win AS (
            SELECT id AS mail_id, message_id
            FROM mail_messages
            WHERE account_id = :acct
              AND date_received > now() - make_interval(days => :days)
              AND message_id IS NOT NULL
        ),
        cargo_counts AS (
            SELECT m.mail_id, COUNT(*) AS n
            FROM win m
            JOIN bazaar_cargo_signals s
              ON s.source LIKE 'imap%'
             AND s.source_id = :pfx || m.message_id || :csfx
            WHERE s.first_seen_at > now() - make_interval(days => :days)
            GROUP BY m.mail_id
        ),
        tonn_counts AS (
            SELECT m.mail_id, COUNT(*) AS n
            FROM win m
            JOIN bazaar_tonnage_signals s
              ON s.source LIKE 'imap%'
             AND s.source_id = :pfx || m.message_id || :tsfx
            WHERE s.first_seen_at > now() - make_interval(days => :days)
            GROUP BY m.mail_id
        )
        SELECT win.mail_id,
               COALESCE(c.n, 0)::int AS cargo_n,
               COALESCE(t.n, 0)::int AS tonn_n
        FROM win
        LEFT JOIN cargo_counts c ON c.mail_id = win.mail_id
        LEFT JOIN tonn_counts  t ON t.mail_id = win.mail_id
        WHERE COALESCE(c.n, 0) + COALESCE(t.n, 0) > 0;
        """
    )
    rows = (await db.execute(sql, {
        "acct": acc.id,
        "days": days,
        "pfx": "imap:",
        "csfx": ":cargo",
        "tsfx": ":tonnage",
    })).all()
    return {r[0]: {"cargo": r[1], "tonnage": r[2]} for r in rows}


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: str,
    authorization: str | None = Header(default=None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Hard-delete one cached message — only within the principal's own account."""
    principal_id, kind = await resolve_principal(authorization, db)
    acc = await _get_account(db, principal_id)
    if not acc:
        return {"deleted": 0, "id": message_id, "status": "not_configured"}
    from ..models import MailMessage
    res = await db.execute(
        sa_delete(MailMessage).where(
            MailMessage.id == message_id, MailMessage.account_id == acc.id
        )
    )
    await db.commit()
    return {"deleted": res.rowcount, "id": message_id}
