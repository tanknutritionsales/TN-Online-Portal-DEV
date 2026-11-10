import { createPortalRuntimeLoader } from "../../lib/netlify-runtime.mjs";

const loadPortal = createPortalRuntimeLoader();

export default async (_request, context) => {
  const { flushCustomerNotifications } = await loadPortal(context);
  const result = await flushCustomerNotifications();
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};

// Idle runs inspect only the lightweight control/retry store, never Postgres.
export const config = { schedule: "* * * * *" };
