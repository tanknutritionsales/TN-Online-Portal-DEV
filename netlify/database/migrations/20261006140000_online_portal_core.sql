CREATE TABLE IF NOT EXISTS op_users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  role text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS op_orders (
  id text PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  customer_id text,
  payment_status text NOT NULL DEFAULT 'pending',
  fulfillment_status text NOT NULL DEFAULT 'not_ready',
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS op_orders_customer_id_idx ON op_orders (customer_id);
CREATE INDEX IF NOT EXISTS op_orders_status_idx ON op_orders (payment_status, fulfillment_status);

CREATE TABLE IF NOT EXISTS op_shop_settings (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
