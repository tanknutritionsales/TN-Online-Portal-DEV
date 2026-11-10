export async function boundedMap(entries, transform, concurrency = 8) {
  let cursor = 0;
  const output = new Array(entries.length);
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    for (;;) { const index = cursor++; if (index >= entries.length) return; output[index] = await transform(entries[index], index); }
  });
  const completed = await Promise.allSettled(workers), failed = completed.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  return output;
}
