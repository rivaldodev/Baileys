"use strict"

/**
 * PostgreSQL-backed Store for Baileys
 * 
 * Persists chats, contacts, messages, and group metadata to PostgreSQL.
 * Compatible with the same event system as the in-memory store.
 * Requires the tables from migrations/002_create_baileys_store_tables.sql.
 * 
 * @module make-postgres-store
 */

Object.defineProperty(exports, "__esModule", { value: true })

const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Utils_1 = require("../Utils")
const WABinary_1 = require("../WABinary")
const generics_1 = require("../Utils/generics")

const serialize = (data) => JSON.stringify(data, generics_1.BufferJSON.replacer)
const deserialize = (data) => JSON.parse(JSON.stringify(data), generics_1.BufferJSON.reviver)

const extractMessageBody = (message) => {
    if (!message?.message) return null
    const m = message.message
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.documentMessage?.caption ||
        m.listResponseMessage?.title ||
        m.buttonsResponseMessage?.selectedDisplayText ||
        m.templateButtonReplyMessage?.selectedDisplayText ||
        null
    )
}

const extractMessageTimestamp = (msg) => {
    if (!msg.messageTimestamp) return 0
    if (typeof msg.messageTimestamp === 'number') return msg.messageTimestamp
    if (typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.low !== undefined) {
        return msg.messageTimestamp.low
    }
    return parseInt(msg.messageTimestamp) || 0
}

/**
 * Creates a PostgreSQL-backed store.
 * 
 * @param {Object} config
 * @param {import('pg').Pool} config.pool - pg Pool instance
 * @param {string} config.sessionId - unique session identifier
 * @param {import('pino').Logger} [config.logger] - pino logger
 */
const makePostgresStore = (config) => {
    const { pool, sessionId } = config
    const logger = config.logger || Defaults_1.DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'pg-store' })

    // ─── Internal helpers ───────────────────────────────────────

    const upsertChat = async (chat) => {
        const ts = chat.conversationTimestamp
            ? (typeof chat.conversationTimestamp === 'number'
                ? chat.conversationTimestamp
                : parseInt(chat.conversationTimestamp) || 0)
            : 0
        await pool.query(
            `INSERT INTO baileys.chats (session_id, jid, data, conversation_ts)
             VALUES ($1, $2, $3::jsonb, $4)
             ON CONFLICT (session_id, jid)
             DO UPDATE SET data = baileys.chats.data || EXCLUDED.data, conversation_ts = EXCLUDED.conversation_ts`,
            [sessionId, chat.id, serialize(chat), ts]
        )
    }

    const upsertContact = async (contact) => {
        await pool.query(
            `INSERT INTO baileys.contacts (session_id, jid, data)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (session_id, jid)
             DO UPDATE SET data = baileys.contacts.data || EXCLUDED.data`,
            [sessionId, contact.id, serialize(contact)]
        )
    }

    const upsertMessage = async (msg) => {
        const jid = WABinary_1.jidNormalizedUser(msg.key.remoteJid)
        const msgId = msg.key.id
        if (!jid || !msgId) return
        const ts = extractMessageTimestamp(msg)
        const body = extractMessageBody(msg)
        const data = serialize(msg)
        // Store body at top level for full-text search
        const dataWithBody = body
            ? JSON.stringify({ ...JSON.parse(data), body })
            : data
        await pool.query(
            `INSERT INTO baileys.messages (session_id, jid, message_id, data, message_ts)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (session_id, jid, message_id)
             DO UPDATE SET data = EXCLUDED.data, message_ts = EXCLUDED.message_ts`,
            [sessionId, jid, msgId, dataWithBody, ts]
        )
    }

    const upsertGroupMetadata = async (group) => {
        await pool.query(
            `INSERT INTO baileys.group_metadata (session_id, jid, data)
             VALUES ($1, $2, $3::jsonb)
             ON CONFLICT (session_id, jid)
             DO UPDATE SET data = EXCLUDED.data`,
            [sessionId, group.id, serialize(group)]
        )
    }

    // ─── Batch helpers ──────────────────────────────────────────

    const batchUpsertChats = async (chats) => {
        if (!chats.length) return
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            for (const chat of chats) {
                const ts = chat.conversationTimestamp
                    ? (typeof chat.conversationTimestamp === 'number'
                        ? chat.conversationTimestamp
                        : parseInt(chat.conversationTimestamp) || 0)
                    : 0
                await client.query(
                    `INSERT INTO baileys.chats (session_id, jid, data, conversation_ts)
                     VALUES ($1, $2, $3::jsonb, $4)
                     ON CONFLICT (session_id, jid) DO NOTHING`,
                    [sessionId, chat.id, serialize(chat), ts]
                )
            }
            await client.query('COMMIT')
        } catch (err) {
            await client.query('ROLLBACK')
            logger.error({ err }, 'batch upsert chats failed')
        } finally {
            client.release()
        }
    }

    const batchUpsertContacts = async (contacts) => {
        if (!contacts.length) return
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            for (const contact of contacts) {
                await client.query(
                    `INSERT INTO baileys.contacts (session_id, jid, data)
                     VALUES ($1, $2, $3::jsonb)
                     ON CONFLICT (session_id, jid)
                     DO UPDATE SET data = baileys.contacts.data || EXCLUDED.data`,
                    [sessionId, contact.id, serialize(contact)]
                )
            }
            await client.query('COMMIT')
        } catch (err) {
            await client.query('ROLLBACK')
            logger.error({ err }, 'batch upsert contacts failed')
        } finally {
            client.release()
        }
    }

    const batchUpsertMessages = async (msgs) => {
        if (!msgs.length) return
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            for (const msg of msgs) {
                const jid = WABinary_1.jidNormalizedUser(msg.key.remoteJid)
                const msgId = msg.key.id
                if (!jid || !msgId) continue
                const ts = extractMessageTimestamp(msg)
                const body = extractMessageBody(msg)
                const data = serialize(msg)
                const dataWithBody = body
                    ? JSON.stringify({ ...JSON.parse(data), body })
                    : data
                await client.query(
                    `INSERT INTO baileys.messages (session_id, jid, message_id, data, message_ts)
                     VALUES ($1, $2, $3, $4::jsonb, $5)
                     ON CONFLICT (session_id, jid, message_id)
                     DO UPDATE SET data = EXCLUDED.data, message_ts = EXCLUDED.message_ts`,
                    [sessionId, jid, msgId, dataWithBody, ts]
                )
            }
            await client.query('COMMIT')
        } catch (err) {
            await client.query('ROLLBACK')
            logger.error({ err }, 'batch upsert messages failed')
        } finally {
            client.release()
        }
    }

    // ─── Event binding ──────────────────────────────────────────

    const bind = (ev) => {
        ev.on('messaging-history.set', async ({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest, syncType }) => {
            if (syncType === WAProto_1.proto.HistorySync.HistorySyncType.ON_DEMAND) {
                // Handle ON_DEMAND: merge messages into existing data
                await batchUpsertMessages(newMessages)
                return
            }
            if (isLatest) {
                await pool.query(`DELETE FROM baileys.chats WHERE session_id = $1`, [sessionId])
                await pool.query(`DELETE FROM baileys.messages WHERE session_id = $1`, [sessionId])
            }
            await batchUpsertChats(newChats)
            await batchUpsertContacts(newContacts)
            await batchUpsertMessages(newMessages)
            logger.debug({ chats: newChats.length, contacts: newContacts.length, messages: newMessages.length }, 'history synced to postgres')
        })

        ev.on('contacts.upsert', async (contacts) => {
            await batchUpsertContacts(contacts)
        })

        ev.on('contacts.update', async (updates) => {
            for (const update of updates) {
                const { rows } = await pool.query(
                    `SELECT data FROM baileys.contacts WHERE session_id = $1 AND jid = $2`,
                    [sessionId, update.id]
                )
                if (rows.length) {
                    const existing = deserialize(rows[0].data)
                    Object.assign(existing, update)
                    await pool.query(
                        `UPDATE baileys.contacts SET data = $3::jsonb WHERE session_id = $1 AND jid = $2`,
                        [sessionId, update.id, serialize(existing)]
                    )
                }
            }
        })

        ev.on('chats.upsert', async (newChats) => {
            for (const chat of newChats) {
                await upsertChat(chat)
            }
        })

        ev.on('chats.update', async (updates) => {
            for (const update of updates) {
                const { rows } = await pool.query(
                    `SELECT data FROM baileys.chats WHERE session_id = $1 AND jid = $2`,
                    [sessionId, update.id]
                )
                if (rows.length) {
                    const existing = deserialize(rows[0].data)
                    if (update.unreadCount > 0) {
                        update.unreadCount = (existing.unreadCount || 0) + update.unreadCount
                    }
                    Object.assign(existing, update)
                    const ts = existing.conversationTimestamp
                        ? (typeof existing.conversationTimestamp === 'number'
                            ? existing.conversationTimestamp
                            : parseInt(existing.conversationTimestamp) || 0)
                        : 0
                    await pool.query(
                        `UPDATE baileys.chats SET data = $3::jsonb, conversation_ts = $4 WHERE session_id = $1 AND jid = $2`,
                        [sessionId, update.id, serialize(existing), ts]
                    )
                }
            }
        })

        ev.on('chats.delete', async (deletions) => {
            if (!deletions.length) return
            await pool.query(
                `DELETE FROM baileys.chats WHERE session_id = $1 AND jid = ANY($2::text[])`,
                [sessionId, deletions]
            )
        })

        ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
            if (type === 'append' || type === 'notify') {
                await batchUpsertMessages(newMessages)

                // Auto-create chats for notify messages
                if (type === 'notify') {
                    for (const msg of newMessages) {
                        const jid = WABinary_1.jidNormalizedUser(msg.key.remoteJid)
                        const { rows } = await pool.query(
                            `SELECT 1 FROM baileys.chats WHERE session_id = $1 AND jid = $2`,
                            [sessionId, jid]
                        )
                        if (!rows.length) {
                            await upsertChat({
                                id: jid,
                                conversationTimestamp: extractMessageTimestamp(msg),
                                unreadCount: 1
                            })
                        }
                    }
                }
            }
        })

        ev.on('messages.update', async (updates) => {
            for (const { update, key } of updates) {
                const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
                const { rows } = await pool.query(
                    `SELECT data FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                    [sessionId, jid, key.id]
                )
                if (rows.length) {
                    const existing = deserialize(rows[0].data)
                    // Don't regress status
                    if (update?.status && existing.status && update.status <= existing.status) {
                        delete update.status
                    }
                    Object.assign(existing, update)
                    const body = extractMessageBody(existing)
                    const data = serialize(existing)
                    const dataWithBody = body
                        ? JSON.stringify({ ...JSON.parse(data), body })
                        : data
                    await pool.query(
                        `UPDATE baileys.messages SET data = $4::jsonb WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                        [sessionId, jid, key.id, dataWithBody]
                    )
                }
            }
        })

        ev.on('messages.delete', async (item) => {
            if ('all' in item) {
                await pool.query(
                    `DELETE FROM baileys.messages WHERE session_id = $1 AND jid = $2`,
                    [sessionId, item.jid]
                )
            } else {
                for (const key of item.keys) {
                    const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
                    await pool.query(
                        `DELETE FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                        [sessionId, jid, key.id]
                    )
                }
            }
        })

        ev.on('groups.upsert', async (newGroups) => {
            for (const group of newGroups) {
                await upsertGroupMetadata(group)
            }
        })

        ev.on('groups.update', async (updates) => {
            for (const update of updates) {
                const { rows } = await pool.query(
                    `SELECT data FROM baileys.group_metadata WHERE session_id = $1 AND jid = $2`,
                    [sessionId, update.id]
                )
                if (rows.length) {
                    const existing = deserialize(rows[0].data)
                    Object.assign(existing, update)
                    await pool.query(
                        `UPDATE baileys.group_metadata SET data = $3::jsonb WHERE session_id = $1 AND jid = $2`,
                        [sessionId, update.id, serialize(existing)]
                    )
                }
            }
        })

        ev.on('group-participants.update', async ({ id, participants, action }) => {
            const { rows } = await pool.query(
                `SELECT data FROM baileys.group_metadata WHERE session_id = $1 AND jid = $2`,
                [sessionId, id]
            )
            if (!rows.length) return
            const metadata = deserialize(rows[0].data)
            if (!metadata.participants) metadata.participants = []

            switch (action) {
                case 'add':
                    metadata.participants.push(
                        ...participants.map(p => {
                            if (typeof p === 'string') return { id: p, admin: null }
                            return {
                                id: p.id || p.phoneNumber || p,
                                phoneNumber: p.phoneNumber,
                                lid: p.lid,
                                admin: p.admin || null,
                                notify: p.notify
                            }
                        })
                    )
                    break
                case 'demote':
                case 'promote':
                    for (const participant of metadata.participants) {
                        const pIds = participants.map(p => typeof p === 'string' ? p : (p.id || p.phoneNumber))
                        if (pIds.includes(participant.id)) {
                            participant.admin = action === 'promote' ? 'admin' : null
                        }
                    }
                    break
                case 'remove':
                    const removeIds = participants.map(p => typeof p === 'string' ? p : (p.id || p.phoneNumber))
                    metadata.participants = metadata.participants.filter(p => !removeIds.includes(p.id))
                    break
            }

            await pool.query(
                `UPDATE baileys.group_metadata SET data = $3::jsonb WHERE session_id = $1 AND jid = $2`,
                [sessionId, id, serialize(metadata)]
            )
        })

        ev.on('message-receipt.update', async (updates) => {
            for (const { key, receipt } of updates) {
                const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
                const { rows } = await pool.query(
                    `SELECT data FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                    [sessionId, jid, key.id]
                )
                if (rows.length) {
                    const msg = WAProto_1.proto.WebMessageInfo.fromObject(deserialize(rows[0].data))
                    Utils_1.updateMessageWithReceipt(msg, receipt)
                    await pool.query(
                        `UPDATE baileys.messages SET data = $4::jsonb WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                        [sessionId, jid, key.id, serialize(msg)]
                    )
                }
            }
        })

        ev.on('messages.reaction', async (reactions) => {
            for (const { key, reaction } of reactions) {
                const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
                const { rows } = await pool.query(
                    `SELECT data FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                    [sessionId, jid, key.id]
                )
                if (rows.length) {
                    const msg = WAProto_1.proto.WebMessageInfo.fromObject(deserialize(rows[0].data))
                    Utils_1.updateMessageWithReaction(msg, reaction)
                    await pool.query(
                        `UPDATE baileys.messages SET data = $4::jsonb WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                        [sessionId, jid, key.id, serialize(msg)]
                    )
                }
            }
        })
    }

    // ─── Query methods ──────────────────────────────────────────

    const loadMessages = async (jid, count, cursor) => {
        const normalizedJid = WABinary_1.jidNormalizedUser(jid)
        let query, params

        if (cursor && 'before' in cursor && cursor.before) {
            // Get the timestamp of the cursor message
            const { rows: cursorRows } = await pool.query(
                `SELECT message_ts FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                [sessionId, normalizedJid, cursor.before.id]
            )
            if (!cursorRows.length) return []
            const cursorTs = cursorRows[0].message_ts
            query = `SELECT data FROM baileys.messages 
                     WHERE session_id = $1 AND jid = $2 AND message_ts < $3
                     ORDER BY message_ts DESC LIMIT $4`
            params = [sessionId, normalizedJid, cursorTs, count]
        } else if (cursor && 'after' in cursor && cursor.after) {
            const { rows: cursorRows } = await pool.query(
                `SELECT message_ts FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
                [sessionId, normalizedJid, cursor.after.id]
            )
            if (!cursorRows.length) return []
            const cursorTs = cursorRows[0].message_ts
            query = `SELECT data FROM baileys.messages 
                     WHERE session_id = $1 AND jid = $2 AND message_ts > $3
                     ORDER BY message_ts ASC LIMIT $4`
            params = [sessionId, normalizedJid, cursorTs, count]
        } else {
            query = `SELECT data FROM baileys.messages 
                     WHERE session_id = $1 AND jid = $2
                     ORDER BY message_ts DESC LIMIT $3`
            params = [sessionId, normalizedJid, count]
        }

        const { rows } = await pool.query(query, params)
        return rows.map(r => WAProto_1.proto.WebMessageInfo.fromObject(deserialize(r.data))).reverse()
    }

    const loadMessage = async (jid, id) => {
        const normalizedJid = WABinary_1.jidNormalizedUser(jid)
        const { rows } = await pool.query(
            `SELECT data FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
            [sessionId, normalizedJid, id]
        )
        if (!rows.length) return undefined
        return WAProto_1.proto.WebMessageInfo.fromObject(deserialize(rows[0].data))
    }

    const mostRecentMessage = async (jid) => {
        const normalizedJid = WABinary_1.jidNormalizedUser(jid)
        const { rows } = await pool.query(
            `SELECT data FROM baileys.messages WHERE session_id = $1 AND jid = $2 ORDER BY message_ts DESC LIMIT 1`,
            [sessionId, normalizedJid]
        )
        if (!rows.length) return undefined
        return WAProto_1.proto.WebMessageInfo.fromObject(deserialize(rows[0].data))
    }

    const getMessage = async (key) => {
        const jid = WABinary_1.jidNormalizedUser(key.remoteJid)
        const { rows } = await pool.query(
            `SELECT data FROM baileys.messages WHERE session_id = $1 AND jid = $2 AND message_id = $3`,
            [sessionId, jid, key.id]
        )
        if (!rows.length) return undefined
        const msg = deserialize(rows[0].data)
        return msg?.message || undefined
    }

    const fetchGroupMetadata = async (jid, sock) => {
        const { rows } = await pool.query(
            `SELECT data FROM baileys.group_metadata WHERE session_id = $1 AND jid = $2`,
            [sessionId, jid]
        )
        if (rows.length) {
            return deserialize(rows[0].data)
        }
        if (sock) {
            const metadata = await sock.groupMetadata(jid)
            if (metadata) {
                await upsertGroupMetadata(metadata)
            }
            return metadata
        }
        return undefined
    }

    const getChat = async (jid) => {
        const { rows } = await pool.query(
            `SELECT data FROM baileys.chats WHERE session_id = $1 AND jid = $2`,
            [sessionId, jid]
        )
        if (!rows.length) return undefined
        return deserialize(rows[0].data)
    }

    const getAllChats = async () => {
        const { rows } = await pool.query(
            `SELECT data FROM baileys.chats WHERE session_id = $1 ORDER BY conversation_ts DESC`,
            [sessionId]
        )
        return rows.map(r => deserialize(r.data))
    }

    const getContact = async (jid) => {
        const { rows } = await pool.query(
            `SELECT data FROM baileys.contacts WHERE session_id = $1 AND jid = $2`,
            [sessionId, jid]
        )
        if (!rows.length) return undefined
        return deserialize(rows[0].data)
    }

    const getAllContacts = async () => {
        const { rows } = await pool.query(
            `SELECT data FROM baileys.contacts WHERE session_id = $1`,
            [sessionId]
        )
        return rows.map(r => deserialize(r.data))
    }

    const getMessageCount = async (jid) => {
        const normalizedJid = jid ? WABinary_1.jidNormalizedUser(jid) : null
        const query = normalizedJid
            ? `SELECT COUNT(*) as cnt FROM baileys.messages WHERE session_id = $1 AND jid = $2`
            : `SELECT COUNT(*) as cnt FROM baileys.messages WHERE session_id = $1`
        const params = normalizedJid ? [sessionId, normalizedJid] : [sessionId]
        const { rows } = await pool.query(query, params)
        return parseInt(rows[0].cnt) || 0
    }

    // ─── Search (Feature #6) ────────────────────────────────────

    /**
     * Search messages by text content.
     * 
     * @param {string} query - text to search for
     * @param {Object} [options]
     * @param {string} [options.jid] - limit search to a specific chat
     * @param {number} [options.limit=50] - max results  
     * @param {number} [options.offset=0] - pagination offset
     * @param {number} [options.startTs] - start timestamp (inclusive)
     * @param {number} [options.endTs] - end timestamp (inclusive)
     * @param {'text'|'image'|'video'|'audio'|'document'|'sticker'} [options.messageType] - filter by message type
     * @returns {Promise<Array>} matching messages
     */
    const searchMessages = async (searchQuery, options = {}) => {
        const { jid, limit = 50, offset = 0, startTs, endTs, messageType } = options
        const conditions = [`session_id = $1`]
        const params = [sessionId]
        let paramIdx = 2

        if (jid) {
            conditions.push(`jid = $${paramIdx}`)
            params.push(WABinary_1.jidNormalizedUser(jid))
            paramIdx++
        }

        if (searchQuery) {
            conditions.push(`data->>'body' ILIKE $${paramIdx}`)
            params.push(`%${searchQuery}%`)
            paramIdx++
        }

        if (startTs !== undefined) {
            conditions.push(`message_ts >= $${paramIdx}`)
            params.push(startTs)
            paramIdx++
        }

        if (endTs !== undefined) {
            conditions.push(`message_ts <= $${paramIdx}`)
            params.push(endTs)
            paramIdx++
        }

        if (messageType) {
            const typeField = `${messageType}Message`
            conditions.push(`data->'message' ? $${paramIdx}`)
            params.push(typeField)
            paramIdx++
        }

        const whereClause = conditions.join(' AND ')
        params.push(limit, offset)

        const { rows } = await pool.query(
            `SELECT data FROM baileys.messages 
             WHERE ${whereClause}
             ORDER BY message_ts DESC 
             LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
            params
        )

        return rows.map(r => {
            const data = deserialize(r.data)
            // Remove the search helper field
            delete data.body
            return WAProto_1.proto.WebMessageInfo.fromObject(data)
        })
    }

    /**
     * Count messages matching a search query.
     */
    const countSearchResults = async (searchQuery, options = {}) => {
        const { jid, startTs, endTs, messageType } = options
        const conditions = [`session_id = $1`]
        const params = [sessionId]
        let paramIdx = 2

        if (jid) {
            conditions.push(`jid = $${paramIdx}`)
            params.push(WABinary_1.jidNormalizedUser(jid))
            paramIdx++
        }

        if (searchQuery) {
            conditions.push(`data->>'body' ILIKE $${paramIdx}`)
            params.push(`%${searchQuery}%`)
            paramIdx++
        }

        if (startTs !== undefined) {
            conditions.push(`message_ts >= $${paramIdx}`)
            params.push(startTs)
            paramIdx++
        }

        if (endTs !== undefined) {
            conditions.push(`message_ts <= $${paramIdx}`)
            params.push(endTs)
            paramIdx++
        }

        if (messageType) {
            const typeField = `${messageType}Message`
            conditions.push(`data->'message' ? $${paramIdx}`)
            params.push(typeField)
            paramIdx++
        }

        const whereClause = conditions.join(' AND ')
        const { rows } = await pool.query(
            `SELECT COUNT(*) as cnt FROM baileys.messages WHERE ${whereClause}`,
            params
        )
        return parseInt(rows[0].cnt) || 0
    }

    /**
     * Get messages by type for a specific chat.
     */
    const getMessagesByType = async (jid, messageType, limit = 50, offset = 0) => {
        return searchMessages(null, { jid, messageType, limit, offset })
    }

    /**
     * Get messages in a date range.
     */
    const getMessagesByDateRange = async (jid, startDate, endDate, limit = 50, offset = 0) => {
        const startTs = Math.floor(startDate.getTime() / 1000)
        const endTs = Math.floor(endDate.getTime() / 1000)
        return searchMessages(null, { jid, startTs, endTs, limit, offset })
    }

    // ─── Cleanup ────────────────────────────────────────────────

    const clearAll = async () => {
        const client = await pool.connect()
        try {
            await client.query('BEGIN')
            await client.query(`DELETE FROM baileys.messages WHERE session_id = $1`, [sessionId])
            await client.query(`DELETE FROM baileys.chats WHERE session_id = $1`, [sessionId])
            await client.query(`DELETE FROM baileys.contacts WHERE session_id = $1`, [sessionId])
            await client.query(`DELETE FROM baileys.group_metadata WHERE session_id = $1`, [sessionId])
            await client.query('COMMIT')
        } catch (err) {
            await client.query('ROLLBACK')
            logger.error({ err }, 'clearAll failed')
        } finally {
            client.release()
        }
    }

    const clearChat = async (jid) => {
        const normalizedJid = WABinary_1.jidNormalizedUser(jid)
        await pool.query(`DELETE FROM baileys.messages WHERE session_id = $1 AND jid = $2`, [sessionId, normalizedJid])
    }

    const getStats = async () => {
        const [chatsRes, contactsRes, messagesRes, groupsRes] = await Promise.all([
            pool.query(`SELECT COUNT(*) as cnt FROM baileys.chats WHERE session_id = $1`, [sessionId]),
            pool.query(`SELECT COUNT(*) as cnt FROM baileys.contacts WHERE session_id = $1`, [sessionId]),
            pool.query(`SELECT COUNT(*) as cnt FROM baileys.messages WHERE session_id = $1`, [sessionId]),
            pool.query(`SELECT COUNT(*) as cnt FROM baileys.group_metadata WHERE session_id = $1`, [sessionId]),
        ])
        return {
            totalChats: parseInt(chatsRes.rows[0].cnt) || 0,
            totalContacts: parseInt(contactsRes.rows[0].cnt) || 0,
            totalMessages: parseInt(messagesRes.rows[0].cnt) || 0,
            totalGroups: parseInt(groupsRes.rows[0].cnt) || 0,
        }
    }

    return {
        bind,
        // Basic queries
        loadMessages,
        loadMessage,
        mostRecentMessage,
        getMessage,
        fetchGroupMetadata,
        getChat,
        getAllChats,
        getContact,
        getAllContacts,
        getMessageCount,
        // Search (Feature #6)
        searchMessages,
        countSearchResults,
        getMessagesByType,
        getMessagesByDateRange,
        // Management
        clearAll,
        clearChat,
        getStats,
    }
}

module.exports = { makePostgresStore }
