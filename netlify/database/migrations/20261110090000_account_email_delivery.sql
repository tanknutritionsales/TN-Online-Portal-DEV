-- Additive only; account verification/reset hashes stay in each account's JSON.
CREATE INDEX IF NOT EXISTS op_customer_messages_email_delivery_idx ON op_customer_messages((data->>'deliveryId')) WHERE kind='email';
CREATE TABLE IF NOT EXISTS op_email_delivery_events (
  id text PRIMARY KEY, message_id text NOT NULL REFERENCES op_customer_messages(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
