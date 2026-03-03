-- =============================================================================
-- Migration: 001_create_baileys_auth_tables.sql
-- Schema   : baileys  (criado previamente via CREATE SCHEMA baileys)
-- Descrição: Tabelas para persistir o estado de autenticação do Baileys
--            substituindo useMultiFileAuthState (arquivos em disco) por
--            armazenamento em PostgreSQL.
--
-- Conexão : configure as variáveis no arquivo .env (ver .env.example)
--
-- Estrutura:
--   baileys.sessions    → Identifica cada sessão WhatsApp (ex.: um bot)
--   baileys.creds       → AuthenticationCreds serializado em JSONB (1 linha/sessão)
--   baileys.signal_keys → Chaves do Signal Protocol indexadas por (type, key_id)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. sessions
--    Registro "raiz" de cada conexão WhatsApp independente.
--    Usar IDs descritivos como 'bot-principal', 'bot-atendimento', etc.
-- ---------------------------------------------------------------------------
CREATE TABLE baileys.sessions (
    id          TEXT        PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  baileys.sessions        IS 'Cada linha representa uma sessão WhatsApp independente (um bot/número).';
COMMENT ON COLUMN baileys.sessions.id     IS 'Identificador descritivo da sessão, ex: bot-principal.';

-- ---------------------------------------------------------------------------
-- 2. creds
--    Equivalente ao arquivo creds.json do useMultiFileAuthState.
--    Armazena AuthenticationCreds completo (ruído, chave de identidade,
--    pre-key assinada, registrationId, advSecretKey, conta, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE baileys.creds (
    session_id  TEXT        NOT NULL
                            REFERENCES baileys.sessions(id)
                            ON DELETE CASCADE,
    data        JSONB       NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id)
);

COMMENT ON TABLE  baileys.creds             IS 'Credenciais de autenticação (AuthenticationCreds) serializadas em JSONB.';
COMMENT ON COLUMN baileys.creds.session_id  IS 'FK para baileys.sessions.id.';
COMMENT ON COLUMN baileys.creds.data        IS 'JSON completo do objeto AuthenticationCreds (noiseKey, signedIdentityKey, etc.).';

-- ---------------------------------------------------------------------------
-- 3. signal_keys
--    Equivalente a todos os arquivos  <type>-<id>.json  do useMultiFileAuthState.
--
--    Tipos conhecidos (SignalDataTypeMap):
--      pre-key              → KeyPair  { public, private }
--      session              → Uint8Array (serializado em base64 via BufferJSON)
--      sender-key           → Uint8Array
--      sender-key-memory    → { [jid: string]: boolean }
--      app-state-sync-key   → proto.Message.AppStateSyncKeyData
--      app-state-sync-version → LTHashState { version, hash, indexValueMap }
--      lid-mapping          → string
--      device-list          → string[]
--      tctoken              → { token: Buffer, timestamp?: string }
--      identity-key         → Uint8Array
-- ---------------------------------------------------------------------------
CREATE TABLE baileys.signal_keys (
    session_id  TEXT        NOT NULL
                            REFERENCES baileys.sessions(id)
                            ON DELETE CASCADE,
    type        TEXT        NOT NULL,   -- ex: 'pre-key', 'session', 'sender-key' …
    key_id      TEXT        NOT NULL,   -- id dentro do tipo, ex: '1', 'jid@s.whatsapp.net:0'
    data        JSONB       NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, type, key_id)
);

COMMENT ON TABLE  baileys.signal_keys           IS 'Chaves do Signal Protocol armazenadas por tipo e id.';
COMMENT ON COLUMN baileys.signal_keys.type      IS 'Tipo da chave conforme SignalDataTypeMap: pre-key, session, sender-key, etc.';
COMMENT ON COLUMN baileys.signal_keys.key_id    IS 'Identificador da chave dentro do tipo (número, JID, etc.).';
COMMENT ON COLUMN baileys.signal_keys.data      IS 'Conteúdo da chave serializado em JSONB via BufferJSON.replacer.';

-- Índice auxiliar para varreduras frequentes por sessão + tipo
CREATE INDEX idx_signal_keys_session_type
    ON baileys.signal_keys (session_id, type);

-- ---------------------------------------------------------------------------
-- 4. Trigger: atualiza updated_at automaticamente em UPDATEs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION baileys.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sessions_updated_at
    BEFORE UPDATE ON baileys.sessions
    FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();

CREATE TRIGGER trg_creds_updated_at
    BEFORE UPDATE ON baileys.creds
    FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();

CREATE TRIGGER trg_signal_keys_updated_at
    BEFORE UPDATE ON baileys.signal_keys
    FOR EACH ROW EXECUTE FUNCTION baileys.set_updated_at();
