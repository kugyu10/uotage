create extension if not exists pgcrypto;

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.operators (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  user_id uuid not null references auth.users (id),
  role text not null default 'owner' check (role in ('owner', 'operator')),
  permissions jsonb not null default '{}'::jsonb,
  unique (tenant_id, user_id),
  unique (tenant_id, id)
);

create or replace function public.is_tenant_operator(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.operators
    where tenant_id = target_tenant_id
      and user_id = auth.uid()
  );
$$;

revoke all on function public.is_tenant_operator(uuid) from public;
grant execute on function public.is_tenant_operator(uuid) to authenticated;

create table public.delivery_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  channel text not null default 'email' check (channel in ('email', 'line', 'email_line')),
  from_name text not null,
  from_email text not null,
  legal_footer text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.readers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  email text not null,
  name text,
  custom_fields jsonb not null default '{}'::jsonb,
  access_token text not null unique,
  unsubscribe_token text not null unique,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, email),
  unique (tenant_id, id)
);

create table public.labels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table public.reader_labels (
  tenant_id uuid not null references public.tenants (id),
  reader_id uuid not null,
  label_id uuid not null,
  granted_at timestamptz not null default now(),
  primary key (reader_id, label_id),
  foreign key (tenant_id, reader_id) references public.readers (tenant_id, id),
  foreign key (tenant_id, label_id) references public.labels (tenant_id, id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  stripe_price_id text not null,
  content_url text,
  post_purchase_scenario_id uuid,
  post_purchase_label_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, post_purchase_label_id) references public.labels (tenant_id, id)
);

create table public.funnels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  name text not null,
  slug text not null,
  trigger_type text not null check (trigger_type in ('registration', 'purchase')),
  product_id uuid,
  deadline_hours integer not null check (deadline_hours >= 0),
  booking_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id),
  constraint funnels_purchase_requires_product check (
    trigger_type <> 'purchase' or product_id is not null
  ),
  constraint funnels_registration_forbids_product check (
    trigger_type <> 'registration' or product_id is null
  )
);

-- 公開登録フォームの URL パラメータ（登録経路）と、付与するラベルの対応。
-- 任意の label_id をクライアントから送らせず、サーバーで検証するための設定テーブル。
create table public.registration_paths (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  funnel_id uuid not null,
  path text not null,
  name text not null,
  label_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, funnel_id, path),
  unique (tenant_id, id),
  foreign key (tenant_id, funnel_id) references public.funnels (tenant_id, id),
  foreign key (tenant_id, label_id) references public.labels (tenant_id, id)
);

create table public.scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  delivery_account_id uuid not null,
  funnel_id uuid,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, delivery_account_id) references public.delivery_accounts (tenant_id, id),
  foreign key (tenant_id, funnel_id) references public.funnels (tenant_id, id)
);

alter table public.products
  add constraint products_post_purchase_scenario_fk
  foreign key (tenant_id, post_purchase_scenario_id)
  references public.scenarios (tenant_id, id);

create table public.step_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  scenario_id uuid not null,
  position integer not null check (position >= 0),
  delay_minutes integer not null check (delay_minutes >= 0),
  send_at_hour integer check (send_at_hour between 0 and 23),
  subject text not null,
  body text not null,
  skip_if_purchased boolean not null default true,
  grant_label_id uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, scenario_id) references public.scenarios (tenant_id, id),
  foreign key (tenant_id, grant_label_id) references public.labels (tenant_id, id)
);

create table public.scenario_readers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  reader_id uuid not null,
  scenario_id uuid not null,
  registered_at timestamptz not null default now(),
  registration_path text,
  deadline_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'completed', 'stopped')),
  unique (reader_id, scenario_id),
  unique (tenant_id, id),
  foreign key (tenant_id, reader_id) references public.readers (tenant_id, id),
  foreign key (tenant_id, scenario_id) references public.scenarios (tenant_id, id)
);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  scenario_reader_id uuid not null,
  step_message_id uuid not null,
  reader_id uuid not null,
  scheduled_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent', 'skipped', 'failed')),
  sent_at timestamptz,
  resend_message_id text,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_message text,
  unique (scenario_reader_id, step_message_id),
  foreign key (tenant_id, scenario_reader_id) references public.scenario_readers (tenant_id, id),
  foreign key (tenant_id, step_message_id) references public.step_messages (tenant_id, id),
  foreign key (tenant_id, reader_id) references public.readers (tenant_id, id)
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id),
  reader_id uuid not null,
  product_id uuid not null,
  stripe_session_id text not null unique,
  amount integer check (amount >= 0),
  purchased_at timestamptz not null default now(),
  foreign key (tenant_id, reader_id) references public.readers (tenant_id, id),
  foreign key (tenant_id, product_id) references public.products (tenant_id, id)
);

-- Explicit indexes required by section 5.3. The token indexes intentionally do
-- not rely on the indexes backing their UNIQUE constraints.
create index readers_access_token_idx on public.readers (access_token);
create index readers_unsubscribe_token_idx on public.readers (unsubscribe_token);
create index deliveries_status_scheduled_at_idx on public.deliveries (status, scheduled_at);
create index reader_labels_label_id_idx on public.reader_labels (label_id);

alter table public.tenants enable row level security;
alter table public.operators enable row level security;
alter table public.delivery_accounts enable row level security;
alter table public.readers enable row level security;
alter table public.labels enable row level security;
alter table public.reader_labels enable row level security;
alter table public.registration_paths enable row level security;
alter table public.funnels enable row level security;
alter table public.scenarios enable row level security;
alter table public.step_messages enable row level security;
alter table public.scenario_readers enable row level security;
alter table public.deliveries enable row level security;
alter table public.products enable row level security;
alter table public.purchases enable row level security;

create policy tenants_operator_access on public.tenants
  for all to authenticated
  using (public.is_tenant_operator(id))
  with check (public.is_tenant_operator(id));

create policy operators_tenant_access on public.operators
  for all to authenticated
  using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));

create policy delivery_accounts_tenant_access on public.delivery_accounts
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy readers_tenant_access on public.readers
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy labels_tenant_access on public.labels
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy reader_labels_tenant_access on public.reader_labels
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy registration_paths_tenant_access on public.registration_paths
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy funnels_tenant_access on public.funnels
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy scenarios_tenant_access on public.scenarios
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy step_messages_tenant_access on public.step_messages
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy scenario_readers_tenant_access on public.scenario_readers
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy deliveries_tenant_access on public.deliveries
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy products_tenant_access on public.products
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
create policy purchases_tenant_access on public.purchases
  for all to authenticated using (public.is_tenant_operator(tenant_id))
  with check (public.is_tenant_operator(tenant_id));
