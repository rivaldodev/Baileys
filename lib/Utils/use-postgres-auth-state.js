"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const WAProto_1 = require("../../WAProto")
const auth_utils_1 = require("./auth-utils")
const generics_1 = require("./generics")

/**
 * Persiste o estado de autenticação do Baileys no PostgreSQL (schema: baileys).
 *
 * Tabelas necessárias (executar migration 001_create_baileys_auth_tables.sql):
 *   baileys.sessions    – registro raiz da sessão
 *   baileys.creds       – AuthenticationCreds serializado em JSONB
 *   baileys.signal_keys – chaves do Signal Protocol indexadas por (type, key_id)
 *
 * @param {import('pg').Pool} pool      Pool de conexões pg já configurado
 * @param {string}            sessionId Identificador único da sessão (ex: 'bot-principal')
 */
const usePostgresAuthState = async (pool, sessionId) => {
    // ------------------------------------------------------------------
    // Garante que a sessão existe na tabela raiz
    // ------------------------------------------------------------------
    await pool.query(
        `INSERT INTO baileys.sessions (id)
         VALUES ($1)
         ON CONFLICT (id) DO NOTHING`,
        [sessionId]
    )

    // ------------------------------------------------------------------
    // Helpers internos
    // ------------------------------------------------------------------

    /**
     * Serializa um valor com BufferJSON.replacer e salva em baileys.creds.
     * Chamado via saveCreds() pelo Baileys sempre que as credenciais mudam.
     */
    const writeCreds = async (data) => {
        const serialized = JSON.stringify(data, generics_1.BufferJSON.replacer)
        await pool.query(
            `INSERT INTO baileys.creds (session_id, data)
             VALUES ($1, $2::jsonb)
             ON CONFLICT (session_id)
             DO UPDATE SET data = EXCLUDED.data`,
            [sessionId, serialized]
        )
    }

    /**
     * Lê as credenciais de baileys.creds e desserializa com BufferJSON.reviver.
     * Retorna null se ainda não houver registro (primeira execução).
     */
    const readCreds = async () => {
        const { rows } = await pool.query(
            `SELECT data FROM baileys.creds WHERE session_id = $1`,
            [sessionId]
        )
        if (!rows.length) return null
        // O PostgreSQL já faz o parse do JSONB; re-stringify para passar pelo reviver
        return JSON.parse(JSON.stringify(rows[0].data), generics_1.BufferJSON.reviver)
    }

    /**
     * Salva uma chave em baileys.signal_keys.
     */
    const writeKey = async (type, keyId, data) => {
        const serialized = JSON.stringify(data, generics_1.BufferJSON.replacer)
        await pool.query(
            `INSERT INTO baileys.signal_keys (session_id, type, key_id, data)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (session_id, type, key_id)
             DO UPDATE SET data = EXCLUDED.data`,
            [sessionId, type, keyId, serialized]
        )
    }

    /**
     * Remove uma chave de baileys.signal_keys (equivale a deletar o arquivo).
     */
    const removeKey = async (type, keyId) => {
        await pool.query(
            `DELETE FROM baileys.signal_keys
             WHERE session_id = $1 AND type = $2 AND key_id = $3`,
            [sessionId, type, keyId]
        )
    }

    /**
     * Busca um lote de chaves por (type, ids[]).
     * Retorna { [id]: valor } — IDs não encontrados são omitidos.
     */
    const readKeys = async (type, ids) => {
        if (!ids.length) return {}
        const { rows } = await pool.query(
            `SELECT key_id, data
             FROM baileys.signal_keys
             WHERE session_id = $1 AND type = $2 AND key_id = ANY($3::text[])`,
            [sessionId, type, ids]
        )
        const result = {}
        for (const row of rows) {
            let value = JSON.parse(JSON.stringify(row.data), generics_1.BufferJSON.reviver)
            // O Baileys exige que chaves app-state-sync-key sejam instâncias proto
            if (type === 'app-state-sync-key' && value) {
                value = WAProto_1.proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            result[row.key_id] = value
        }
        return result
    }

    // ------------------------------------------------------------------
    // Carrega (ou inicializa) as credenciais
    // ------------------------------------------------------------------
    const creds = (await readCreds()) || auth_utils_1.initAuthCreds()

    // ------------------------------------------------------------------
    // Interface compatível com AuthenticationState do Baileys
    // ------------------------------------------------------------------
    return {
        state: {
            creds,
            keys: {
                /**
                 * Lê um ou mais IDs de um determinado tipo de chave Signal.
                 * @param {string}   type  Tipo da chave (pre-key, session, sender-key, …)
                 * @param {string[]} ids   Lista de IDs a buscar
                 */
                get: async (type, ids) => {
                    return readKeys(type, ids)
                },

                /**
                 * Grava ou apaga chaves Signal em lote.
                 * Um valor null indica deleção.
                 * @param {import('../Types').SignalDataSet} data
                 */
                set: async (data) => {
                    const writes = []
                    for (const type in data) {
                        for (const keyId in data[type]) {
                            const value = data[type][keyId]
                            if (value !== null && value !== undefined) {
                                writes.push(writeKey(type, keyId, value))
                            } else {
                                writes.push(removeKey(type, keyId))
                            }
                        }
                    }
                    await Promise.all(writes)
                },

                /**
                 * Remove TODAS as chaves desta sessão (equivale a limpar a sessão).
                 */
                clear: async () => {
                    await pool.query(
                        `DELETE FROM baileys.signal_keys WHERE session_id = $1`,
                        [sessionId]
                    )
                }
            }
        },

        /**
         * Persiste as credenciais atuais no PostgreSQL.
         * Deve ser passado como callback saveCreds para o makeWASocket.
         */
        saveCreds: () => writeCreds(creds),

        /**
         * Remove completamente a sessão (creds + signal keys) do banco.
         * Útil para logout / reset de sessão.
         */
        deleteSession: async () => {
            // ON DELETE CASCADE cuida de creds e signal_keys automaticamente
            await pool.query(
                `DELETE FROM baileys.sessions WHERE id = $1`,
                [sessionId]
            )
        }
    }
}

module.exports = { usePostgresAuthState }
