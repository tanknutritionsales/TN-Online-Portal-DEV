// Serialize settings patches so two admins editing different modules do not erase each other.
export function createSettingsUpdater({ useDatabase, database, read, write, normalize, defaults }) {
  let localQueue = Promise.resolve();
  return async function updateSettings(transform) {
    if (!useDatabase()) {
      const result = localQueue.catch(() => {}).then(async () => write(await transform((await read()).settings)));
      localQueue = result;
      return result;
    }
    const client = await (await database()).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('op_shop_settings_default'))");
      const current = await client.query("SELECT data FROM op_shop_settings WHERE id='default' FOR UPDATE");
      const settings = normalize(await transform(normalize(current.rows[0]?.data || defaults())));
      await client.query("INSERT INTO op_shop_settings(id,data,updated_at) VALUES('default',$1::jsonb,now()) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=EXCLUDED.updated_at", [JSON.stringify(settings)]);
      await client.query("COMMIT");
      return { version: 1, updatedAt: new Date().toISOString(), settings };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  };
}
