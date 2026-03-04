-- Migration: 002_create_baileys_store_tables.sql
-- Schema   : baileys
-- Tables: baileys.chats, baileys.contacts, baileys.messages, baileys.group_metadata, baileys.deleted_messages

-- Chats table
CREATE TABLE IF NOT EXISTS baileys.chats (
    session_id      TEXT NOT NULL REFERENCES baileys.sessions(id) ON DELETE CASCADE,
    jid             TEXT NOT NULL,
    data            JSONB NOT NULL,
    conversation_ts BIGINT DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, jid)
);

CREATE INDEX idx_chats_session_ts ON baileys.chats (session_id, conversation_ts DESC);

-- Contacts table
CREATE TABLE IF NOT EXISTS baileys.contacts (
    session_id  TEXT NOT NULL REFERENCES baileys.sessions(id) ON DELETE CASCADE,
    jid         TEXT NOT NULL,
    data        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, jid)
);

-- Messages table
CREATE TABLE IF NOT EXISTS baileys.messages (
    session_id      TEXT NOT NULL REFERENCES baileys.sessions(id) ON DELETE CASCADE,
    jid             TEXT NOT NULL,
    message_id      TEXT NOT NULL,
    data            JSONB NOT NULL,
    message_ts      BIGINT DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, jid, message_id)
);

CREATE INDEX idx_messages_session_jid_ts ON baileys.messages (session_id, jid, message_ts DESC);
CREATE INDEX idx_messages_fulltext ON baileys.messages USING GIN ((data->>'body'));

-- Group metadata table
CREATE TABLE IF NOT EXISTS baileys.group_metadata (
    session_id  TEXT NOT NULL REFERENCES baileys.sessions(id) ON DELETE CASCADE,
    jid         TEXT NOT NULL,
    data        JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, jid)
);

-- Deleted messages table (anti-delete persistence)
CREATE TABLE IF NOT EXISTS baileys.deleted_messages (
    session_id          TEXT NOT NULL REFERENCES baileys.sessions(id) ON DELETE CASCADE,
    jid                 TEXT NOT NULL,
    message_id          TEXT NOT NULL,
    original_message    JSONB NOT NULL,
    deleted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_by          TEXT,
    is_revoked_by_sender BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (session_id, jid, message_id)
);

CREATE INDEX idx_deleted_messages_session_jid ON baileys.deleted_messages (session_id, jid, deleted_at DESC);

-- Update triggers
CREATE TRIGGER trg_chats_updated_at BEFORE UPDATE ON baileys.chats FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();
CREATE TRIGGER trg_contacts_updated_at BEFORE UPDATE ON baileys.contacts FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();
CREATE TRIGGER trg_messages_updated_at BEFORE UPDATE ON baileys.messages FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();
CREATE TRIGGER trg_group_metadata_updated_at BEFORE UPDATE ON baileys.group_metadata FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();
CREATE TRIGGER trg_deleted_messages_updated_at BEFORE UPDATE ON baileys.deleted_messages FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();
