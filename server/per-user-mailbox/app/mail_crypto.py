"""Symmetric encryption for per-user mailbox secrets (IMAP/SMTP passwords).

Passwords are encrypted with Fernet (AES-128-CBC + HMAC-SHA256) using the
server-only key MAILBOX_SECRET_KEY. Ciphertext is stored in
mail_accounts.secret_ciphertext; the plaintext password is decrypted ONLY
inside the poller/sender just before an IMAP/SMTP login, and is NEVER
returned to the client or written to logs.

If MAILBOX_SECRET_KEY is unset, encryption is unavailable: save endpoints
must refuse rather than store plaintext. Lost/rotated key ⇒ all stored
secrets become undecryptable and users must re-enter — back the key up.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from .config import get_settings


@lru_cache(maxsize=1)
def _fernet():
    """Build the Fernet instance once. Returns None when no key is set."""
    key = get_settings().mailbox_secret_key
    if not key:
        return None
    from cryptography.fernet import Fernet  # lazy import — optional dep
    return Fernet(key.encode("utf-8") if isinstance(key, str) else key)


def crypto_available() -> bool:
    """True when a usable MAILBOX_SECRET_KEY is configured."""
    try:
        return _fernet() is not None
    except Exception:
        return False


def encrypt_secret(plaintext: str) -> str:
    """Encrypt a password → urlsafe token (str). Raises if key missing."""
    f = _fernet()
    if f is None:
        raise RuntimeError("MAILBOX_SECRET_KEY not configured")
    return f.encrypt((plaintext or "").encode("utf-8")).decode("ascii")


def decrypt_secret(ciphertext: Optional[str]) -> str:
    """Decrypt a stored token → password. Empty/None ⇒ ''."""
    if not ciphertext:
        return ""
    f = _fernet()
    if f is None:
        raise RuntimeError("MAILBOX_SECRET_KEY not configured")
    return f.decrypt(ciphertext.encode("ascii")).decode("utf-8")
