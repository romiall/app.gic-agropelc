-- MP-11 (AV-282, décision du porteur du 14/10/2026 : blocage immédiat) : la garde d'authentification
-- vérifie à chaque requête qu'une session de la famille du jeton est encore vivante — index sur la
-- famille. Le changement de mot de passe révoque les autres sessions de l'utilisateur (revue adverse
-- de MP-11 : un tiers connecté avec le mot de passe provisoire n'en était pas évincé) — motif
-- `PASSWORD_CHANGED`.
--
-- migrate:up transaction:false
CREATE INDEX ix_identity_auth_sessions_family ON identity_auth_sessions (token_family_id, revoked_at);
ALTER TABLE identity_auth_sessions DROP CHECK ck_identity_auth_sessions_revoked_reason;
ALTER TABLE identity_auth_sessions ADD CONSTRAINT ck_identity_auth_sessions_revoked_reason CHECK (
  revoked_reason IS NULL OR revoked_reason IN (
    'LOGOUT', 'ADMIN', 'USER_DEACTIVATED', 'DEVICE_BLOCKED', 'TOKEN_REUSE', 'EXPIRED', 'ROTATED',
    'PASSWORD_CHANGED'
  )
);

-- migrate:down transaction:false
ALTER TABLE identity_auth_sessions DROP CHECK ck_identity_auth_sessions_revoked_reason;
ALTER TABLE identity_auth_sessions ADD CONSTRAINT ck_identity_auth_sessions_revoked_reason CHECK (
  revoked_reason IS NULL OR revoked_reason IN (
    'LOGOUT', 'ADMIN', 'USER_DEACTIVATED', 'DEVICE_BLOCKED', 'TOKEN_REUSE', 'EXPIRED', 'ROTATED'
  )
);
DROP INDEX ix_identity_auth_sessions_family ON identity_auth_sessions;
