BEGIN;

CREATE OR REPLACE FUNCTION enforce_instagram_connection_plan_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_limit integer;
  v_status text;
  v_count integer;
BEGIN
  IF NEW.status NOT IN (
    'connected',
    'reauth_required'
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status IN (
       'connected',
       'reauth_required'
     )
     AND OLD.workspace_id = NEW.workspace_id
     AND OLD.instagram_account_id =
         NEW.instagram_account_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(NEW.workspace_id::text)
  );
  SELECT
    p.max_instagram_accounts,
    ws.status
  INTO
    v_limit,
    v_status
  FROM workspace_subscriptions ws
  JOIN plans p
    ON p.code = ws.plan_code
  WHERE ws.workspace_id =
        NEW.workspace_id
  LIMIT 1;

  IF v_limit IS NULL THEN
    RAISE EXCEPTION
      'workspace subscription not found'
      USING ERRCODE = 'RL001';
  END IF;

  IF v_status NOT IN (
    'active',
    'trialing'
  ) THEN
    RAISE EXCEPTION
      'workspace subscription is inactive'
      USING ERRCODE = 'RL002';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_count
  FROM instagram_connections ic
  WHERE ic.workspace_id =
        NEW.workspace_id
    AND ic.status IN (
      'connected',
      'reauth_required'
    )
    AND ic.id <> NEW.id;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION
      'instagram account plan limit reached'
      USING ERRCODE = 'RL101';
  END IF;

  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS
  instagram_connections_plan_limit_guard
ON instagram_connections;

CREATE TRIGGER
  instagram_connections_plan_limit_guard
BEFORE INSERT OR UPDATE
ON instagram_connections
FOR EACH ROW
EXECUTE FUNCTION
  enforce_instagram_connection_plan_limit();


CREATE OR REPLACE FUNCTION enforce_automation_plan_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_workspace_id uuid;
  v_connection_status text;
  v_limit integer;
  v_status text;
  v_count integer;
BEGIN
  IF NEW.active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.active IS TRUE
     AND OLD.instagram_account_id =
         NEW.instagram_account_id THEN
    RETURN NEW;
  END IF;
  SELECT
    latest.workspace_id,
    latest.status
  INTO
    v_workspace_id,
    v_connection_status
  FROM LATERAL (
    SELECT
      ic.workspace_id,
      ic.status
    FROM instagram_connections ic
    WHERE ic.instagram_account_id =
          NEW.instagram_account_id
    ORDER BY
      ic.connected_at DESC,
      ic.created_at DESC
    LIMIT 1
  ) latest;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION
      'instagram account has no workspace connection'
      USING ERRCODE = 'RL201';
  END IF;

  IF v_connection_status <> 'connected' THEN
    RAISE EXCEPTION
      'instagram account is not connected'
      USING ERRCODE = 'RL202';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(v_workspace_id::text)
  );
  SELECT
    p.max_active_automations,
    ws.status
  INTO
    v_limit,
    v_status
  FROM workspace_subscriptions ws
  JOIN plans p
    ON p.code = ws.plan_code
  WHERE ws.workspace_id =
        v_workspace_id
  LIMIT 1;

  IF v_limit IS NULL THEN
    RAISE EXCEPTION
      'workspace subscription not found'
      USING ERRCODE = 'RL001';
  END IF;

  IF v_status NOT IN (
    'active',
    'trialing'
  ) THEN
    RAISE EXCEPTION
      'workspace subscription is inactive'
      USING ERRCODE = 'RL002';
  END IF;

  SELECT COUNT(*)::integer
  INTO v_count
  FROM automations a
  JOIN instagram_accounts ia
    ON ia.id = a.instagram_account_id
  JOIN LATERAL (
    SELECT
      ic.workspace_id,
      ic.status
    FROM instagram_connections ic
    WHERE ic.instagram_account_id =
          ia.id
    ORDER BY
      ic.connected_at DESC,
      ic.created_at DESC
    LIMIT 1
  ) latest
    ON TRUE
  WHERE latest.workspace_id =
        v_workspace_id
    AND latest.status IN (
      'connected',
      'reauth_required'
    )
    AND a.active = TRUE
    AND a.id <> NEW.id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION
      'active automation plan limit reached'
      USING ERRCODE = 'RL301';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS
  automations_plan_limit_guard
ON automations;

CREATE TRIGGER
  automations_plan_limit_guard
BEFORE INSERT OR UPDATE
ON automations
FOR EACH ROW
EXECUTE FUNCTION
  enforce_automation_plan_limit();

COMMIT;
