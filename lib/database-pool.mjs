// Coalesce the whole asynchronous initialization, not only the final Pool value.
export function createDatabasePool({ connectionString, loadDriver = () => import("pg"), onIdleError = () => {} }) {
  let flight;
  return function database() {
    if (!flight) flight = (async () => {
      const url = await connectionString();
      if (!url) throw new Error("Database connection string is not configured.");
      const driver = await loadDriver(), Pool = driver.Pool || driver.default?.Pool;
      const pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000,
        statement_timeout: 12000, idle_in_transaction_session_timeout: 15000, maxLifetimeSeconds: 300 });
      pool.on("error", onIdleError);
      return pool;
    })().catch(error => { flight = null; throw error; });
    return flight;
  };
}
