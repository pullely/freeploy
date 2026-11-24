-- 580_identity_avatars
-- Profile pictures (freeploy-coolify-parity DP3). Coolify keeps them on a
-- storage disk; Freeploy has no object storage bound yet, so the (browser-
-- compressed, 256 px JPEG, at most 5 MB as Coolify allows) image is kept here,
-- base64, one per user.
-- Bounded context: identity

CREATE TABLE IF NOT EXISTS identity.avatars (
  user_id       UUID        PRIMARY KEY REFERENCES identity.users(id),
  content_type  TEXT        NOT NULL,
  data          TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
