BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =========================================================
-- USERS
-- =========================================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    email TEXT NOT NULL,
    password_hash TEXT,

    display_name TEXT,

    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX users_email_unique
    ON users (LOWER(email));


-- =========================================================
-- WORKSPACES / TENANTS
-- =========================================================

CREATE TABLE workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    name TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'closed')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE workspace_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE,

    user_id UUID NOT NULL
        REFERENCES users(id) ON DELETE CASCADE,

    role TEXT NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member')),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (workspace_id, user_id)
);


-- =========================================================
-- INSTAGRAM PROFESSIONAL ACCOUNT IDENTITY
--
-- IMPORTANT:
-- professional_account_id is the ID we expect to match
-- webhook entry.id.
--
-- app_scoped_user_id is kept separately.
-- =========================================================

CREATE TABLE instagram_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    professional_account_id TEXT NOT NULL,
    app_scoped_user_id TEXT,

    username TEXT,
    account_type TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (professional_account_id)
);


CREATE INDEX instagram_accounts_app_scoped_user_id_idx
    ON instagram_accounts(app_scoped_user_id);


-- =========================================================
-- INSTAGRAM CONNECTION
--
-- Token encryption:
-- AES-256-GCM done by Node.js.
--
-- Store ciphertext + IV + auth tag separately.
-- =========================================================

CREATE TABLE instagram_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    workspace_id UUID NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE,

    instagram_account_id UUID NOT NULL
        REFERENCES instagram_accounts(id) ON DELETE RESTRICT,

    token_ciphertext TEXT,
    token_iv TEXT,
    token_auth_tag TEXT,
    token_key_version INTEGER,

    token_expires_at TIMESTAMPTZ,
    token_last_refreshed_at TIMESTAMPTZ,

    status TEXT NOT NULL DEFAULT 'connected'
        CHECK (
            status IN (
                'connected',
                'reauth_required',
                'disconnected',
                'error'
            )
        ),

    comments_subscribed_at TIMESTAMPTZ,

    reauth_required_at TIMESTAMPTZ,
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disconnected_at TIMESTAMPTZ,

    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Only ONE live connection for an Instagram account,
-- regardless of workspace.
CREATE UNIQUE INDEX instagram_connections_one_live_account
    ON instagram_connections(instagram_account_id)
    WHERE status IN ('connected', 'reauth_required');


CREATE INDEX instagram_connections_workspace_idx
    ON instagram_connections(workspace_id);


CREATE INDEX instagram_connections_refresh_idx
    ON instagram_connections(token_expires_at)
    WHERE status = 'connected';


-- =========================================================
-- OAUTH STATE
--
-- Never store the raw state token.
-- Store SHA-256(state) here.
-- =========================================================

CREATE TABLE oauth_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    state_hash TEXT NOT NULL UNIQUE,

    workspace_id UUID NOT NULL
        REFERENCES workspaces(id) ON DELETE CASCADE,

    requested_by_user_id UUID
        REFERENCES users(id) ON DELETE SET NULL,

    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX oauth_states_pending_idx
    ON oauth_states(expires_at)
    WHERE consumed_at IS NULL;


-- =========================================================
-- AUTOMATIONS
-- =========================================================

CREATE TABLE automations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    instagram_account_id UUID NOT NULL
        REFERENCES instagram_accounts(id) ON DELETE CASCADE,

    instagram_media_id TEXT NOT NULL,

    keyword TEXT NOT NULL,

    destination_url TEXT NOT NULL,

    dm_template TEXT NOT NULL,

    public_reply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    public_reply_template TEXT,

    match_mode TEXT NOT NULL DEFAULT 'exact'
        CHECK (match_mode IN ('exact', 'contains')),

    active BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Prevent two active automations for the same
-- account + media + normalized keyword.
CREATE UNIQUE INDEX automations_active_trigger_unique
    ON automations (
        instagram_account_id,
        instagram_media_id,
        LOWER(BTRIM(keyword))
    )
    WHERE active = TRUE;


CREATE INDEX automations_lookup_idx
    ON automations(
        instagram_account_id,
        instagram_media_id
    )
    WHERE active = TRUE;


-- =========================================================
-- RAW WEBHOOK EVENTS
-- =========================================================

CREATE TABLE webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    event_hash TEXT UNIQUE,

    instagram_account_id UUID
        REFERENCES instagram_accounts(id) ON DELETE SET NULL,

    payload JSONB NOT NULL,

    signature_valid BOOLEAN NOT NULL,

    status TEXT NOT NULL DEFAULT 'received'
        CHECK (
            status IN (
                'received',
                'queued',
                'processed',
                'ignored',
                'failed'
            )
        ),

    error_message TEXT,

    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);


CREATE INDEX webhook_events_received_idx
    ON webhook_events(received_at DESC);


CREATE INDEX webhook_events_status_idx
    ON webhook_events(status);


-- =========================================================
-- PROCESSED COMMENTS
--
-- comment_id is globally UNIQUE.
-- This is deliberate.
-- =========================================================

CREATE TABLE processed_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    comment_id TEXT NOT NULL UNIQUE,

    instagram_account_id UUID NOT NULL
        REFERENCES instagram_accounts(id) ON DELETE CASCADE,

    automation_id UUID
        REFERENCES automations(id) ON DELETE SET NULL,

    webhook_event_id UUID
        REFERENCES webhook_events(id) ON DELETE SET NULL,

    instagram_media_id TEXT NOT NULL,

    commenter_id TEXT,
    commenter_username TEXT,

    comment_text TEXT,

    comment_created_at TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    status TEXT NOT NULL DEFAULT 'received'
        CHECK (
            status IN (
                'received',
                'queued',
                'processing',
                'completed',
                'ignored',
                'failed'
            )
        ),

    ignore_reason TEXT,
    failure_message TEXT,

    processed_at TIMESTAMPTZ
);


CREATE INDEX processed_comments_account_idx
    ON processed_comments(instagram_account_id);


CREATE INDEX processed_comments_received_idx
    ON processed_comments(received_at DESC);


CREATE INDEX processed_comments_status_idx
    ON processed_comments(status);


-- =========================================================
-- PRIVATE REPLY / DM LOG
--
-- One row per comment.
-- This reinforces Meta's one-private-reply behavior.
-- =========================================================

CREATE TABLE dm_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    comment_id TEXT NOT NULL UNIQUE,

    instagram_account_id UUID NOT NULL
        REFERENCES instagram_accounts(id) ON DELETE CASCADE,

    automation_id UUID
        REFERENCES automations(id) ON DELETE SET NULL,

    recipient_id TEXT,
    message_id TEXT,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'sending',
                'sent',
                'failed',
                'expired',
                'skipped'
            )
        ),

    attempt_count INTEGER NOT NULL DEFAULT 0,

    failure_code TEXT,
    failure_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX dm_logs_account_idx
    ON dm_logs(instagram_account_id);


CREATE INDEX dm_logs_status_idx
    ON dm_logs(status);


-- =========================================================
-- TOKEN REFRESH HISTORY
-- =========================================================

CREATE TABLE token_refresh_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    instagram_connection_id UUID NOT NULL
        REFERENCES instagram_connections(id) ON DELETE CASCADE,

    status TEXT NOT NULL
        CHECK (status IN ('success', 'failed')),

    previous_expires_at TIMESTAMPTZ,
    new_expires_at TIMESTAMPTZ,

    error_message TEXT,

    attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE INDEX token_refresh_logs_connection_idx
    ON token_refresh_logs(
        instagram_connection_id,
        attempted_at DESC
    );


COMMIT;
