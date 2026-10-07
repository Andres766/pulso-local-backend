import pg from 'pg';

/**
 * Envoltura del pool de PostgreSQL. Expone solo consultas parametrizadas
 * (nunca concatenación de SQL → sin inyección SQL) y un helper transaccional.
 */
export class Database {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
    // NUMERIC llega como string por defecto; lo convertimos a number (nuestros valores son pequeños).
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
  }

  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, params);
  }

  /** Ejecuta `work` dentro de una transacción; hace ROLLBACK ante cualquier error. */
  async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
