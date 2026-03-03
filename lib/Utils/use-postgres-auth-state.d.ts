import type { Pool } from 'pg'
import type { AuthenticationState } from '../Types'

/**
 * Persiste o estado de autenticação do Baileys no PostgreSQL.
 *
 * Requer:
 *   - Pacote `pg` instalado (`npm install pg`)
 *   - Migration `001_create_baileys_auth_tables.sql` aplicada no banco
 *   - Schema `baileys` com as tabelas `sessions`, `creds` e `signal_keys`
 *
 * @example
 * ```ts
 * import { Pool } from 'pg'
 * import makeWASocket, { usePostgresAuthState } from '@innovatorssoft/baileys'
 *
 * // Configure as variáveis de ambiente no arquivo .env (ver .env.example)
 * const pool = new Pool({
 *   host: process.env.PG_HOST,
 *   port: Number(process.env.PG_PORT),
 *   user: process.env.PG_USER,
 *   password: process.env.PG_PASSWORD,
 *   database: process.env.PG_DATABASE,
 * })
 *
 * const { state, saveCreds } = await usePostgresAuthState(pool, 'bot-principal')
 *
 * const sock = makeWASocket({ auth: state })
 * sock.ev.on('creds.update', saveCreds)
 * ```
 */
export declare const usePostgresAuthState: (
    pool: Pool,
    sessionId: string
) => Promise<{
    /** Estado de autenticação pronto para ser passado ao makeWASocket */
    state: AuthenticationState

    /** Persiste as credenciais atualizadas no PostgreSQL */
    saveCreds: () => Promise<void>

    /** Remove toda a sessão do banco (logout / reset) */
    deleteSession: () => Promise<void>
}>
