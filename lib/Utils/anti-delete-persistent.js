"use strict"

/**
 * Anti-Delete with PostgreSQL Persistence
 * 
 * Extended version of the anti-delete module that stores deleted messages
 * in PostgreSQL so they survive restarts. Falls back to in-memory for
 * fast access with periodic DB sync.
 * 
 * Requires tables from migrations/002_create_baileys_store_tables.sql.
 * 
 * @module anti-delete-persistent
 */

Object.defineProperty(exports, "__esModule", { value: true })
exports.PersistentMessageStore = void 0
exports.createPersistentAntiDeleteHandler = createPersistentAntiDeleteHandler
exports.createPersistentMessageStoreHandler = createPersistentMessageStoreHandler
exports.bindPersistentAntiDelete = bindPersistentAntiDelete

const index_js_1 = require("../../WAProto/index.js")
const WABinary_1 = require("../WABinary")
const generics_1 = require("../Utils/generics")

const serialize = (data) => JSON.stringify(data, generics_1.BufferJSON.replacer)
const deserialize = (data) => JSON.parse(JSON.stringify(data), generics_1.BufferJSON.reviver)

/**
 * Persistent Message Store - combines in-memory cache with PostgreSQL persistence.
 * 
 * Messages are cached in memory for fast access and written to PostgreSQL
 * for durability. Deleted messages are tracked and persisted so they can 
 * be recovered even after a restart.
 */
class PersistentMessageStore {
    /**
     * @param {Object} options
     * @param {import('pg').Pool} options.pool - pg Pool instance
     * @param {string} options.sessionId - unique session identifier
     * @param {number} [options.maxMessagesPerChat=1000] - max messages per chat in memory
     * @param {number} [options.ttl=86400000] - TTL in ms for in-memory cache (default 24h)
     * @param {number} [options.cleanupInterval=3600000] - cleanup interval in ms
     * @param {import('pino').Logger} [options.logger] - optional logger
     */
    constructor(options = {}) {
        this.pool = options.pool
        this.sessionId = options.sessionId
        this.logger = options.logger || console

        // In-memory cache for fast access
        this.memoryStore = new Map()
        this.deletedCache = new Map()
        
        this.options = {
            maxMessagesPerChat: options.maxMessagesPerChat || 1000,
            ttl: options.ttl || 24 * 60 * 60 * 1000,
            cleanupInterval: options.cleanupInterval || 60 * 60 * 1000,
        }

        this.startCleanup()
    }

    startCleanup() {
        this.cleanupTimer = setInterval(() => {
            this.cleanupMemory()
        }, this.options.cleanupInterval)
    }

    stopCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer)
        }
    }

    /**
     * Cleanup expired entries from in-memory cache only.
     * PostgreSQL data is retained until explicit deletion.
     */
    cleanupMemory() {
        const now = Date.now()
        const cutoff = now - this.options.ttl

        for (const [chatId, messages] of this.memoryStore) {
            for (const [msgId, stored] of messages) {
                if (stored.storedAt < cutoff) {
                    messages.delete(msgId)
                }
            }
            if (messages.size === 0) {
                this.memoryStore.delete(chatId)
            }
        }

        for (const [key, info] of this.deletedCache) {
            if (info.deletedAt < cutoff) {
                this.deletedCache.delete(key)
            }
        }
    }

    _getKey(key) {
        return `${key.remoteJid}:${key.id}`
    }

    // ─── Store messages ─────────────────────────────────────

    /**
     * Store a message in both memory and PostgreSQL.
     */
    async storeMessage(message) {
        const chatId = message.key.remoteJid
        const msgId = message.key.id
        if (!chatId || !msgId) return

        // Memory cache
        let chatMessages = this.memoryStore.get(chatId)
        if (!chatMessages) {
            chatMessages = new Map()
            this.memoryStore.set(chatId, chatMessages)
        }

        if (chatMessages.size >= this.options.maxMessagesPerChat) {
            const oldestKey = chatMessages.keys().next().value
            if (oldestKey) {
                chatMessages.delete(oldestKey)
            }
        }

        chatMessages.set(msgId, {
            message,
            storedAt: Date.now(),
            isDeleted: false,
        })

        // PostgreSQL - store in messages table (reuse existing table)
        try {
            const jid = WABinary_1.jidNormalizedUser(chatId)
            const ts = this._extractTimestamp(message)
            await this.pool.query(
                `INSERT INTO baileys.messages (session_id, jid, message_id, data, message_ts)
                 VALUES ($1, $2, $3, $4::jsonb, $5)
                 ON CONFLICT (session_id, jid, message_id)
                 DO UPDATE SET data = EXCLUDED.data, message_ts = EXCLUDED.message_ts`,
                [this.sessionId, jid, msgId, serialize(message), ts]
            )
        } catch (err) {
            this.logger.error?.({ err }, 'failed to persist message') || 
            this.logger.error?.(`failed to persist message: ${err.message}`)
        }
    }

    /**
     * Store multiple messages.
     */
    async storeMessages(messages) {
        const client = await this.pool.connect()
        try {
            await client.query('BEGIN')
            for (const msg of messages) {
                const chatId = msg.key.remoteJid
                const msgId = msg.key.id
                if (!chatId || !msgId) continue

                // Memory cache
                let chatMessages = this.memoryStore.get(chatId)
                if (!chatMessages) {
                    chatMessages = new Map()
                    this.memoryStore.set(chatId, chatMessages)
                }
                if (chatMessages.size >= this.options.maxMessagesPerChat) {
                    const oldestKey = chatMessages.keys().next().value
                    if (oldestKey) chatMessages.delete(oldestKey)
                }
                chatMessages.set(msgId, {
                    message: msg,
                    storedAt: Date.now(),
                    isDeleted: false,
                })

                // DB
                const jid = WABinary_1.jidNormalizedUser(chatId)
                const ts = this._extractTimestamp(msg)
                await client.query(
                    `INSERT INTO baileys.messages (session_id, jid, message_id, data, message_ts)
                     VALUES ($1, $2, $3, $4::jsonb, $5)
                     ON CONFLICT (session_id, jid, message_id)
                     DO UPDATE SET data = EXCLUDED.data, message_ts = EXCLUDED.message_ts`,
                    [this.sessionId, jid, msgId, serialize(msg), ts]
                )
            }
            await client.query('COMMIT')
        } catch (err) {
            await client.query('ROLLBACK')
            this.logger.error?.({ err }, 'failed to batch persist messages')
        } finally {
            client.release()
        }
    }

    _extractTimestamp(msg) {
        if (!msg.messageTimestamp) return 0
        if (typeof msg.messageTimestamp === 'number') return msg.messageTimestamp
        if (typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.low !== undefined) {
            return msg.messageTimestamp.low
        }
        return parseInt(msg.messageTimestamp) || 0
    }

    // ─── Retrieve messages ──────────────────────────────────

    /**
     * Get message from memory cache first, fallback to PostgreSQL.
     */
    async getMessage(key) {
        // Try memory first
        const chatMessages = this.memoryStore.get(key.remoteJid)
        if (chatMessages) {
            const stored = chatMessages.get(key.id)
            if (stored) return stored
        }

        // Fallback to DB
        try {
            const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
            const { rows } = await this.pool.query(
                `SELECT data FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                [this.sessionId, jid, key.id]
            )
            if (rows.length) {
                const message = deserialize(rows[0].data)
                return { message, storedAt: Date.now(), isDeleted: false }
            }
        } catch (err) {
            this.logger.error?.({ err }, 'failed to read message from DB')
        }

        return undefined
    }

    /**
     * Get original message object.
     */
    async getOriginalMessage(key) {
        const stored = await this.getMessage(key)
        return stored?.message
    }

    // ─── Delete tracking ────────────────────────────────────

    /**
     * Mark a message as deleted. Stores the deletion info in both
     * memory and PostgreSQL (deleted_messages table).
     */
    async markAsDeleted(key, deletedBy) {
        const stored = await this.getMessage(key)
        if (!stored) return null

        const now = Date.now()
        stored.isDeleted = true
        stored.deletedAt = now
        stored.deletedBy = deletedBy

        const isRevokedBySender = !deletedBy || deletedBy === stored.message.key?.participant

        const info = {
            originalMessage: stored.message,
            key,
            deletedAt: now,
            deletedBy,
            isRevokedBySender,
        }

        // Memory cache
        this.deletedCache.set(this._getKey(key), info)

        // Persist to DB
        try {
            const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
            await this.pool.query(
                `INSERT INTO baileys.deleted_messages (session_id, jid, message_id, original_message, deleted_at, deleted_by, is_revoked_by_sender)
                 VALUES ($1, $2, $3, $4::jsonb, NOW(), $5, $6)
                 ON CONFLICT (session_id, jid, message_id)
                 DO UPDATE SET original_message = EXCLUDED.original_message, deleted_at = EXCLUDED.deleted_at, 
                              deleted_by = EXCLUDED.deleted_by, is_revoked_by_sender = EXCLUDED.is_revoked_by_sender`,
                [this.sessionId, jid, key.id, serialize(stored.message), deletedBy || null, isRevokedBySender]
            )
        } catch (err) {
            this.logger.error?.({ err }, 'failed to persist deleted message')
        }

        return info
    }

    /**
     * Get a deleted message from cache or DB.
     */
    async getDeletedMessage(key) {
        // Memory first
        const cached = this.deletedCache.get(this._getKey(key))
        if (cached) return cached

        // DB fallback
        try {
            const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
            const { rows } = await this.pool.query(
                `SELECT original_message, deleted_at, deleted_by, is_revoked_by_sender
                 FROM baileys.deleted_messages 
                 WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                [this.sessionId, jid, key.id]
            )
            if (rows.length) {
                const row = rows[0]
                return {
                    originalMessage: deserialize(row.original_message),
                    key,
                    deletedAt: new Date(row.deleted_at).getTime(),
                    deletedBy: row.deleted_by,
                    isRevokedBySender: row.is_revoked_by_sender,
                }
            }
        } catch (err) {
            this.logger.error?.({ err }, 'failed to read deleted message from DB')
        }

        return undefined
    }

    /**
     * Get all deleted messages, combining memory cache + DB.
     */
    async getAllDeletedMessages() {
        try {
            const { rows } = await this.pool.query(
                `SELECT jid, message_id, original_message, deleted_at, deleted_by, is_revoked_by_sender
                 FROM baileys.deleted_messages 
                 WHERE session_id = $1
                 ORDER BY deleted_at DESC`,
                [this.sessionId]
            )
            return rows.map(row => ({
                originalMessage: deserialize(row.original_message),
                key: { remoteJid: row.jid, id: row.message_id },
                deletedAt: new Date(row.deleted_at).getTime(),
                deletedBy: row.deleted_by,
                isRevokedBySender: row.is_revoked_by_sender,
            }))
        } catch (err) {
            this.logger.error?.({ err }, 'failed to read all deleted messages')
            // Fallback to memory
            return Array.from(this.deletedCache.values())
        }
    }

    /**
     * Get deleted messages for a specific chat.
     */
    async getDeletedMessagesByChat(chatId) {
        try {
            const jid = WABinary_1.jidNormalizedUser(chatId)
            const { rows } = await this.pool.query(
                `SELECT jid, message_id, original_message, deleted_at, deleted_by, is_revoked_by_sender
                 FROM baileys.deleted_messages 
                 WHERE session_id = $1 AND jid = $2
                 ORDER BY deleted_at DESC`,
                [this.sessionId, jid]
            )
            return rows.map(row => ({
                originalMessage: deserialize(row.original_message),
                key: { remoteJid: row.jid, id: row.message_id },
                deletedAt: new Date(row.deleted_at).getTime(),
                deletedBy: row.deleted_by,
                isRevokedBySender: row.is_revoked_by_sender,
            }))
        } catch (err) {
            this.logger.error?.({ err }, 'failed to read deleted messages by chat')
            return Array.from(this.deletedCache.values()).filter(
                info => info.key.remoteJid === chatId
            )
        }
    }

    /**
     * Search deleted messages by text content.
     */
    async searchDeletedMessages(query, options = {}) {
        const { jid, limit = 50, offset = 0 } = options
        const conditions = [`session_id = $1`]
        const params = [this.sessionId]
        let paramIdx = 2

        if (jid) {
            conditions.push(`jid = $${paramIdx}`)
            params.push(WABinary_1.jidNormalizedUser(jid))
            paramIdx++
        }

        if (query) {
            conditions.push(`original_message::text ILIKE $${paramIdx}`)
            params.push(`%${query}%`)
            paramIdx++
        }

        const whereClause = conditions.join(' AND ')
        params.push(limit, offset)

        try {
            const { rows } = await this.pool.query(
                `SELECT jid, message_id, original_message, deleted_at, deleted_by, is_revoked_by_sender
                 FROM baileys.deleted_messages 
                 WHERE ${whereClause}
                 ORDER BY deleted_at DESC 
                 LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
                params
            )
            return rows.map(row => ({
                originalMessage: deserialize(row.original_message),
                key: { remoteJid: row.jid, id: row.message_id },
                deletedAt: new Date(row.deleted_at).getTime(),
                deletedBy: row.deleted_by,
                isRevokedBySender: row.is_revoked_by_sender,
            }))
        } catch (err) {
            this.logger.error?.({ err }, 'failed to search deleted messages')
            return []
        }
    }

    // ─── Chat helpers ───────────────────────────────────────

    getChatMessages(chatId) {
        const chatMessages = this.memoryStore.get(chatId)
        if (!chatMessages) return []
        return Array.from(chatMessages.values()).map(s => s.message)
    }

    getChatIds() {
        return Array.from(this.memoryStore.keys())
    }

    async getStats() {
        const memoryStats = { totalChats: this.memoryStore.size, totalMessages: 0 }
        for (const messages of this.memoryStore.values()) {
            memoryStats.totalMessages += messages.size
        }
        
        try {
            const [msgRes, delRes] = await Promise.all([
                this.pool.query(`SELECT COUNT(*) as cnt FROM baileys.messages WHERE session_id = $1`, [this.sessionId]),
                this.pool.query(`SELECT COUNT(*) as cnt FROM baileys.deleted_messages WHERE session_id = $1`, [this.sessionId]),
            ])
            return {
                memory: memoryStats,
                database: {
                    totalMessages: parseInt(msgRes.rows[0].cnt) || 0,
                    totalDeleted: parseInt(delRes.rows[0].cnt) || 0,
                }
            }
        } catch (err) {
            return {
                memory: memoryStats,
                database: { totalMessages: 0, totalDeleted: 0, error: err.message }
            }
        }
    }

    // ─── Cleanup ────────────────────────────────────────────

    clear() {
        this.memoryStore.clear()
        this.deletedCache.clear()
    }

    clearChat(chatId) {
        this.memoryStore.delete(chatId)
    }

    /**
     * Purge deleted messages older than the given duration from PostgreSQL.
     * @param {number} olderThanMs - duration in milliseconds
     */
    async purgeOldDeletedMessages(olderThanMs) {
        const cutoff = new Date(Date.now() - olderThanMs)
        try {
            const { rowCount } = await this.pool.query(
                `DELETE FROM baileys.deleted_messages WHERE session_id = $1 AND deleted_at < $2`,
                [this.sessionId, cutoff]
            )
            return rowCount
        } catch (err) {
            this.logger.error?.({ err }, 'failed to purge old deleted messages')
            return 0
        }
    }

    /**
     * Load deleted messages from DB into memory cache on startup.
     * @param {number} [limit=500] - max messages to load
     */
    async loadFromDatabase(limit = 500) {
        try {
            const { rows } = await this.pool.query(
                `SELECT jid, message_id, original_message, deleted_at, deleted_by, is_revoked_by_sender
                 FROM baileys.deleted_messages 
                 WHERE session_id = $1
                 ORDER BY deleted_at DESC 
                 LIMIT $2`,
                [this.sessionId, limit]
            )
            for (const row of rows) {
                const key = { remoteJid: row.jid, id: row.message_id }
                this.deletedCache.set(this._getKey(key), {
                    originalMessage: deserialize(row.original_message),
                    key,
                    deletedAt: new Date(row.deleted_at).getTime(),
                    deletedBy: row.deleted_by,
                    isRevokedBySender: row.is_revoked_by_sender,
                })
            }
            return rows.length
        } catch (err) {
            this.logger.error?.({ err }, 'failed to load deleted messages from DB')
            return 0
        }
    }
}

exports.PersistentMessageStore = PersistentMessageStore

/**
 * Creates the anti-delete handler for messages.update events
 * that persists deletions to PostgreSQL.
 */
function createPersistentAntiDeleteHandler(store) {
    return async (updates) => {
        const deletedMessages = []
        for (const { key, update } of updates) {
            if (update.messageStubType === index_js_1.proto.WebMessageInfo.StubType.REVOKE) {
                const deletedInfo = await store.markAsDeleted(
                    key,
                    update.messageStubParameters?.[0]
                )
                if (deletedInfo) {
                    deletedMessages.push(deletedInfo)
                }
            }
        }
        return deletedMessages
    }
}

/**
 * Creates the message store handler for messages.upsert events
 * that persists messages to PostgreSQL.
 */
function createPersistentMessageStoreHandler(store) {
    return async ({ messages }) => {
        const regularMessages = messages.filter(msg => {
            const content = msg.message
            if (!content) return false
            if (content.protocolMessage) return false
            if (content.senderKeyDistributionMessage) return false
            return true
        })
        await store.storeMessages(regularMessages)
    }
}

/**
 * Convenience function to bind the persistent anti-delete system
 * to a Baileys event emitter.
 * 
 * @param {BaileysEventEmitter} ev - the socket event emitter
 * @param {PersistentMessageStore} store - the persistent store
 * @param {Function} [onDelete] - callback when a message is deleted, receives DeletedMessageInfo
 * @returns {PersistentMessageStore} the store instance
 * 
 * @example
 * ```js
 * const { Pool } = require('pg')
 * const { PersistentMessageStore, bindPersistentAntiDelete } = require('@innovatorssoft/baileys')
 * 
 * const pool = new Pool({ connectionString: 'postgres://...' })
 * const antiDelete = new PersistentMessageStore({ pool, sessionId: 'my-session' })
 * await antiDelete.loadFromDatabase() // load previous deleted messages
 * 
 * const sock = makeWASocket({ ... })
 * bindPersistentAntiDelete(sock.ev, antiDelete, (deleted) => {
 *     console.log('Message deleted!', deleted.originalMessage)
 * })
 * ```
 */
function bindPersistentAntiDelete(ev, store, onDelete) {
    const msgHandler = createPersistentMessageStoreHandler(store)
    const deleteHandler = createPersistentAntiDeleteHandler(store)

    ev.on('messages.upsert', async (data) => {
        await msgHandler(data)
    })

    ev.on('messages.update', async (updates) => {
        const deleted = await deleteHandler(updates)
        if (deleted.length && onDelete) {
            for (const info of deleted) {
                onDelete(info)
            }
        }
    })

    return store
}

exports.default = {
    PersistentMessageStore,
    createPersistentAntiDeleteHandler,
    createPersistentMessageStoreHandler,
    bindPersistentAntiDelete,
}
