-- Draft hosted schema for Online Portal.
-- Do not run against production until local testing is approved and migrations are planned.

create table portal_accounts (
  id uuid primary key,
  role text not null check (role in ('customer', 'admin')),
  username text not null unique,
  email text not null unique,
  name text not null,
  phone_area text not null default '+27',
  phone_number text not null default '',
  phone text not null default '',
  password_hash text not null,
  default_address jsonb not null default '{}'::jsonb,
  preferences jsonb not null default '{"theme":"light"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table portal_account_addresses (
  id uuid primary key,
  account_id uuid not null references portal_accounts(id) on delete cascade,
  label text not null,
  line1 text not null,
  line2 text not null default '',
  suburb text not null,
  city text not null,
  province text not null,
  postal_code text not null,
  country text not null default 'South Africa',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table portal_orders (
  id uuid primary key,
  reference text not null unique,
  customer_id uuid not null references portal_accounts(id),
  customer_snapshot jsonb not null,
  delivery_address jsonb not null,
  delivery_address_text text not null,
  delivery_method text not null default 'Courier',
  delivery_notes text not null default '',
  subtotal numeric(12, 2) not null,
  delivery_fee numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  payment_status text not null check (payment_status in ('pending', 'confirmed', 'rejected')),
  fulfillment_status text not null check (fulfillment_status in ('not_ready', 'back_order', 'shipped')),
  payment_confirmed_at timestamptz,
  payment_confirmed_by text,
  back_order_reason text not null default '',
  tracking jsonb,
  shopify_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table portal_order_items (
  id uuid primary key,
  order_id uuid not null references portal_orders(id) on delete cascade,
  shopify_variant_id text not null,
  product_title text not null,
  variant_title text not null default 'Default Title',
  sku text,
  quantity integer not null check (quantity > 0),
  price numeric(12, 2) not null,
  line_total numeric(12, 2) not null,
  created_at timestamptz not null default now()
);

create table portal_payment_proofs (
  id uuid primary key,
  order_id uuid not null references portal_orders(id) on delete cascade,
  filename text not null,
  storage_key text not null,
  content_type text,
  size_bytes bigint,
  note text not null default '',
  uploaded_by_customer_id uuid references portal_accounts(id),
  uploaded_at timestamptz not null default now()
);

create table portal_order_status_events (
  id uuid primary key,
  order_id uuid not null references portal_orders(id) on delete cascade,
  actor_type text not null,
  actor_label text not null,
  event_type text not null,
  label text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table portal_internal_api_tokens (
  id uuid primary key,
  name text not null,
  token_hash text not null unique,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index portal_accounts_role_idx on portal_accounts(role, created_at desc);
create index portal_account_addresses_account_idx on portal_account_addresses(account_id, is_default desc);
create index portal_orders_customer_idx on portal_orders(customer_id, created_at desc);
create index portal_orders_ops_queue_idx on portal_orders(payment_status, fulfillment_status, payment_confirmed_at desc);
create index portal_order_items_order_idx on portal_order_items(order_id);
create index portal_payment_proofs_order_idx on portal_payment_proofs(order_id);
create index portal_order_status_events_order_idx on portal_order_status_events(order_id, created_at desc);
