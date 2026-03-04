import type { Logger } from 'pino'
import type { Pool } from 'pg'
import { proto } from '../../WAProto'
import type makeMDSocket from '../Socket'
import type { BaileysEventEmitter, Chat, Contact, GroupMetadata, WAMessage, WAMessageCursor, WAMessageKey } from '../Types'

type WASocket = ReturnType<typeof makeMDSocket>

export interface PostgresStoreConfig {
    /** pg Pool instance */
    pool: Pool
    /** Unique session identifier (same as auth session) */
    sessionId: string
    /** Optional pino logger */
    logger?: Logger
}

export interface MessageSearchOptions {
    /** Limit search to a specific chat JID */
    jid?: string
    /** Maximum results (default: 50) */
    limit?: number
    /** Pagination offset (default: 0) */
    offset?: number
    /** Start timestamp (Unix seconds, inclusive) */
    startTs?: number
    /** End timestamp (Unix seconds, inclusive) */
    endTs?: number
    /** Filter by message type */
    messageType?: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker'
}

export interface StoreStats {
    totalChats: number
    totalContacts: number
    totalMessages: number
    totalGroups: number
}

export declare const makePostgresStore: (config: PostgresStoreConfig) => {
    /** Bind to the Baileys event emitter to auto-sync data */
    bind: (ev: BaileysEventEmitter) => void

    // ─── Basic Queries ──────────────────────────────────────
    /** Load messages for a chat with cursor-based pagination */
    loadMessages: (jid: string, count: number, cursor?: WAMessageCursor) => Promise<proto.IWebMessageInfo[]>
    /** Load a single message by JID and message ID */
    loadMessage: (jid: string, id: string) => Promise<proto.IWebMessageInfo | undefined>
    /** Get the most recent message in a chat */
    mostRecentMessage: (jid: string) => Promise<proto.IWebMessageInfo | undefined>
    /** Get a message's content (for retry system) */
    getMessage: (key: WAMessageKey) => Promise<proto.IMessage | undefined>
    /** Fetch group metadata, optionally querying WhatsApp if not in DB */
    fetchGroupMetadata: (jid: string, sock?: WASocket) => Promise<GroupMetadata | undefined>
    /** Get a single chat */
    getChat: (jid: string) => Promise<Chat | undefined>
    /** Get all chats sorted by conversation timestamp */
    getAllChats: () => Promise<Chat[]>
    /** Get a single contact */
    getContact: (jid: string) => Promise<Contact | undefined>
    /** Get all contacts */
    getAllContacts: () => Promise<Contact[]>
    /** Count messages, optionally for a specific chat */
    getMessageCount: (jid?: string) => Promise<number>

    // ─── Search ─────────────────────────────────────────────
    /** Full-text search on message body with filters */
    searchMessages: (query: string | null, options?: MessageSearchOptions) => Promise<proto.IWebMessageInfo[]>
    /** Count results matching a search query */
    countSearchResults: (query: string | null, options?: MessageSearchOptions) => Promise<number>
    /** Get messages filtered by media type */
    getMessagesByType: (jid: string, messageType: MessageSearchOptions['messageType'], limit?: number, offset?: number) => Promise<proto.IWebMessageInfo[]>
    /** Get messages within a date range */
    getMessagesByDateRange: (jid: string, startDate: Date, endDate: Date, limit?: number, offset?: number) => Promise<proto.IWebMessageInfo[]>

    // ─── Management ─────────────────────────────────────────
    /** Delete all store data for this session */
    clearAll: () => Promise<void>
    /** Delete all messages for a specific chat */
    clearChat: (jid: string) => Promise<void>
    /** Get stats about the store */
    getStats: () => Promise<StoreStats>
}
