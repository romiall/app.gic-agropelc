-- P0-09 (2/2) : rotation du jeton de rafraîchissement (07-security-rbac/02-securite.md §3
-- « rotation à chaque usage, famille de rotation »). La détection de réutilisation exige de
-- garder trace des jetons déjà tournés (une ligne par étape de rotation, même
-- token_family_id) : présenter un jeton dont la ligne a déjà `revoked_at` renseigné est soit
-- une réutilisation malveillante (TOKEN_REUSE, déjà prévu), soit simplement la ligne
-- remplacée par une rotation normale — aucune des six valeurs existantes ne nomme ce second
-- cas sans induire en erreur (« EXPIRED »/« LOGOUT » seraient faux). Ajout de `ROTATED`.
--
-- migrate:up transaction:false
ALTER TABLE identity_auth_sessions DROP CHECK ck_identity_auth_sessions_revoked_reason;
ALTER TABLE identity_auth_sessions ADD CONSTRAINT ck_identity_auth_sessions_revoked_reason CHECK (
  revoked_reason IS NULL OR revoked_reason IN (
    'LOGOUT', 'ADMIN', 'USER_DEACTIVATED', 'DEVICE_BLOCKED', 'TOKEN_REUSE', 'EXPIRED', 'ROTATED'
  )
);

-- migrate:down transaction:false
ALTER TABLE identity_auth_sessions DROP CHECK ck_identity_auth_sessions_revoked_reason;
ALTER TABLE identity_auth_sessions ADD CONSTRAINT ck_identity_auth_sessions_revoked_reason CHECK (
  revoked_reason IS NULL OR revoked_reason IN (
    'LOGOUT', 'ADMIN', 'USER_DEACTIVATED', 'DEVICE_BLOCKED', 'TOKEN_REUSE', 'EXPIRED'
  )
);
