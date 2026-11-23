create table fact_media_checkpoints (
  order_id text primary key references fact_orders (order_id) on delete cascade,
  source_url text not null,
  payload text not null,
  expires_at timestamptz not null
);

create index fact_media_checkpoints_expiry_idx on fact_media_checkpoints (expires_at);
