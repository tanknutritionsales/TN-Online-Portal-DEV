import { flushCustomerNotifications } from "../../server.js";

export default async () => {
  const result = await flushCustomerNotifications();
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "*/5 * * * *" };
