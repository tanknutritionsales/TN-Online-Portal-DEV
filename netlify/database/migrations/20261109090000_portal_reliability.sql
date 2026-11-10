-- Additive reliability indexes, submission ledger, messages and distributed limits.
-- Existing accounts/orders/settings are preserved. No data seed or reset.

CREATE TABLE IF NOT EXISTS op_users (
  id text PRIMARY KEY, username text NOT NULL UNIQUE, email text NOT NULL UNIQUE,
  role text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS op_orders (
  id text PRIMARY KEY, reference text NOT NULL UNIQUE, customer_id text,
  payment_status text NOT NULL DEFAULT 'pending', fulfillment_status text NOT NULL DEFAULT 'not_ready',
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS op_orders_customer_created_idx ON op_orders(customer_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS op_orders_status_idx ON op_orders(payment_status, fulfillment_status);
CREATE INDEX IF NOT EXISTS op_orders_created_idx ON op_orders(created_at DESC, id);
CREATE INDEX IF NOT EXISTS op_orders_legacy_request_idx ON op_orders(customer_id, (data->>'idempotencyKey'));
CREATE TABLE IF NOT EXISTS op_shop_settings (
  id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS op_storage_meta (
  key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS op_order_submissions (
  customer_id text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
  order_id text NOT NULL REFERENCES op_orders(id), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(customer_id, request_key)
);
CREATE TABLE IF NOT EXISTS op_customer_messages (
  id text PRIMARY KEY, kind text NOT NULL, customer_id text NOT NULL, order_id text,
  status text NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS op_customer_messages_customer_idx ON op_customer_messages(customer_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS op_customer_messages_delivery_idx ON op_customer_messages(kind, status, updated_at);
CREATE INDEX IF NOT EXISTS op_customer_messages_order_kind_idx ON op_customer_messages(order_id, kind);


CREATE TABLE IF NOT EXISTS op_rate_limits (
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  window_start_ms bigint NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_hash, window_start_ms)
);
CREATE INDEX IF NOT EXISTS op_rate_limits_expiry_idx ON op_rate_limits (expires_at);
