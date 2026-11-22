-- Leave historical records in place and expose only actual checks to the app.
alter table fact_orders add column is_check boolean not null default false;
alter table fact_orders alter column amount set default 0;

create view fact_checks as
select order_id, user_id, url, plan, lang, status as stored_status,
  case when status = 'paid' then 'queued' else status end as status,
  request_key, credit_attempt_id, result_json, report_json, error, claim_token,
  retry_after_at, progress_stage, created_at, updated_at
from fact_orders
where is_check or (payment_method in ('admin', 'credit') and paid_at is not null);
