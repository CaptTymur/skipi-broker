"""per-user mailbox: extend mail_accounts with principal + encrypted creds

Revision ID: e4b2f9a1c7d6
Revises: 7d2b1f9c4a6e
Create Date: 2026-06-22 00:30:00.000000

Adds the per-user mailbox columns to the existing (already multi-account
capable) mail_accounts table. No data migration here; the legacy drybulk
account is seeded separately by a one-off script so the change is reviewable
and reversible on its own.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e4b2f9a1c7d6"
down_revision: Union[str, Sequence[str], None] = "7d2b1f9c4a6e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("mail_accounts", sa.Column("principal_id", sa.String(length=36), nullable=True))
    op.add_column("mail_accounts", sa.Column("principal_kind", sa.String(length=8), nullable=True))
    op.add_column("mail_accounts", sa.Column("username", sa.String(length=240), nullable=True))
    op.add_column("mail_accounts", sa.Column("secret_ciphertext", sa.Text(), nullable=True))
    op.add_column("mail_accounts", sa.Column("imap_security", sa.String(length=10), nullable=True))
    op.add_column("mail_accounts", sa.Column("smtp_security", sa.String(length=10), nullable=True))
    op.add_column("mail_accounts", sa.Column("reply_to", sa.String(length=240), nullable=True))
    op.add_column("mail_accounts", sa.Column("provider", sa.String(length=20), nullable=True))
    op.add_column("mail_accounts", sa.Column("status", sa.String(length=16), nullable=True))
    op.add_column("mail_accounts", sa.Column("last_error", sa.Text(), nullable=True))
    op.add_column(
        "mail_accounts",
        sa.Column("extract_to_bazaar", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_mail_accounts_principal_id", "mail_accounts", ["principal_id"], unique=True)
    op.create_index("ix_mail_accounts_status", "mail_accounts", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_mail_accounts_status", table_name="mail_accounts")
    op.drop_index("ix_mail_accounts_principal_id", table_name="mail_accounts")
    for col in (
        "extract_to_bazaar", "last_error", "status", "provider", "reply_to",
        "smtp_security", "imap_security", "secret_ciphertext", "username",
        "principal_kind", "principal_id",
    ):
        op.drop_column("mail_accounts", col)
