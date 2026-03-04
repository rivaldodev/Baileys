import type { Pool } from 'pg'
import type { Logger } from 'pino'
import type { WAMessage, WAMessageKey, BaileysEventEmitter } from '../Types'

export interface PersistentStoredMessage {
    message: WAMessage
    storedAt: number
    isDeleted: boolean
    deletedAt?: number
    deletedBy?: string
}

export interface PersistentDeletedMessageInfo {
    originalMessage: WAMessage
    key: WAMessageKey
    deletedAt: number
    deletedBy?: string
    isRevokedBySender: boolean
}

export interface PersistentMessageStoreOptions {
    /** pg Pool instance */
    pool: Pool
    /** Unique session identifier */
    sessionId: string
    /** Max messages per chat in memory (default: 1000) */
    maxMessagesPerChat?: number
    /** TTL in ms for in-memory cache (default: 24h) */
    ttl?: number
    /** Cleanup interval in ms (default: 1h) */
    cleanupInterval?: number
    /** Optional pino logger */
    logger?: Logger
}

export interface PersistentStoreStats {
    memory: {
        totalChats: number
        totalMessages: number
    }
    database: {
        totalMessages: number
        totalDeleted: number
        error?: string
    }
}

export declare class PersistentMessageStore {
    constructor(options?: PersistentMessageStoreOptions)

    /** Stop the cleanup interval timer */
    stopCleanup(): void
    /** Clean up expired entries from memory cache */
    cleanupMemory(): void

    /** Store a single message in memory + PostgreSQL */
    storeMessage(message: WAMessage): Promise<void>
    /** Store multiple messages in memory + PostgreSQL (batched transaction) */
    storeMessages(messages: WAMessage[]): Promise<void>

    /** Get a stored message (memory-first, DB fallback) */
    getMessage(key: WAMessageKey): Promise<PersistentStoredMessage | undefined>
    /** Get the original WAMessage object */
    getOriginalMessage(key: WAMessageKey): Promise<WAMessage | undefined>

    /** Mark a message as deleted and persist to PostgreSQL */
    markAsDeleted(key: WAMessageKey, deletedBy?: string): Promise<PersistentDeletedMessageInfo | null>
    /** Get a single deleted message info */
    getDeletedMessage(key: WAMessageKey): Promise<PersistentDeletedMessageInfo | undefined>
    /** Get all deleted messages from PostgreSQL */
    getAllDeletedMessages(): Promise<PersistentDeletedMessageInfo[]>
    /** Get deleted messages for a specific chat */
    getDeletedMessagesByChat(chatId: string): Promise<PersistentDeletedMessageInfo[]>
    /** Search deleted messages by text content */
    searchDeletedMessages(query: string, options?: { jid?: string; limit?: number; offset?: number }): Promise<PersistentDeletedMessageInfo[]>

    /** Get messages from memory cache for a chat */
    getChatMessages(chatId: string): WAMessage[]
    /** Get all chat IDs from memory cache */
    getChatIds(): string[]
    /** Get stats from both memory and database */
    getStats(): Promise<PersistentStoreStats>

    /** Clear memory caches */
    clear(): void
    /** Clear memory cache for a specific chat */
    clearChat(chatId: string): void
    /** Purge deleted messages older than given duration from PostgreSQL */
    purgeOldDeletedMessages(olderThanMs: number): Promise<number>
    /** Load deleted messages from DB into memory cache on startup */
    loadFromDatabase(limit?: number): Promise<number>
}

/** Creates handler for messages.update that persists deletions */
export declare function createPersistentAntiDeleteHandler(
    store: PersistentMessageStore
): (updates: { key: WAMessageKey; update: Partial<WAMessage> }[]) => Promise<PersistentDeletedMessageInfo[]>

/** Creates handler for messages.upsert that persists messages */
export declare function createPersistentMessageStoreHandler(
    store: PersistentMessageStore
): (data: { messages: WAMessage[] }) => Promise<void>

/** 
 * Bind the persistent anti-delete system to a Baileys event emitter.
 * Automatically stores incoming messages and tracks deletions.
 */
export declare function bindPersistentAntiDelete(
    ev: BaileysEventEmitter,
    store: PersistentMessageStore,
    onDelete?: (info: PersistentDeletedMessageInfo) => void
): PersistentMessageStore

declare const _default: {
    PersistentMessageStore: typeof PersistentMessageStore
    createPersistentAntiDeleteHandler: typeof createPersistentAntiDeleteHandler
    createPersistentMessageStoreHandler: typeof createPersistentMessageStoreHandler
    bindPersistentAntiDelete: typeof bindPersistentAntiDelete
}
export default _default
