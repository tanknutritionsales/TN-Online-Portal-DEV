// Reporting dates use the office's calendar (South Africa, UTC+02:00).
const day = 86400000;
function invalid() { throw Object.assign(new Error("Choose a valid date range."), { status: 400 }); }
function midnight(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "") || value.startsWith("0000")) return invalid();
  const time = Date.parse(`${value}T00:00:00+02:00`);
  if (!Number.isFinite(time) || new Date(time + 7200000).toISOString().slice(0, 10) !== value) return invalid();
  return time;
}
export function reportingPeriod(params, { defaultPeriod = "30d", now = Date.now() } = {}) {
  const key = params.get("period") || defaultPeriod;
  if (!["today", "7d", "30d", "90d", "all", "custom"].includes(key)) return invalid();
  if (key === "all") return { key, label: "All time", from: null, to: null, fromDate: "", toDate: "" };
  const today = new Date(now + 7200000).toISOString().slice(0, 10);
  const endDate = key === "custom" ? params.get("to") : today;
  const end = midnight(endDate);
  const start = key === "custom" ? midnight(params.get("from")) : end - ((key === "today" ? 1 : Number(key.slice(0, -1))) - 1) * day;
  if (start > end) return invalid();
  const fromDate = new Date(start + 7200000).toISOString().slice(0, 10);
  return { key, label: key === "today" ? "Today" : key === "custom" ? `${fromDate} – ${endDate}` : `Last ${key.slice(0, -1)} days`,
    from: new Date(start).toISOString(), to: new Date(end + day).toISOString(), fromDate, toDate: endDate };
}
