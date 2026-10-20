-- #39 Normalise publisher email case to prevent duplicate accounts
--
-- This migration lowercases and trims existing email values in the publishers
-- table. If any collisions exist (two rows that will have the same normalised
-- email), the UPDATE will fail with a unique constraint violation. The error
-- message lists the conflicting emails so an administrator can manually merge
-- or delete duplicates before retrying.

DO $$
DECLARE
  collision_count INT;
  collision_list TEXT;
BEGIN
  -- Check for collisions before updating. The subquery returns rows that will
  -- collide after normalisation: groups of publishers whose LOWER(TRIM(email))
  -- values are identical and count > 1.
  SELECT COUNT(*), STRING_AGG(DISTINCT LOWER(TRIM(email)), ', ')
  INTO collision_count, collision_list
  FROM publishers
  GROUP BY LOWER(TRIM(email))
  HAVING COUNT(*) > 1;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'Cannot normalise publisher emails: % collision(s) found for: %', 
      collision_count, collision_list;
  END IF;

  -- No collisions detected; safe to normalise.
  UPDATE publishers
  SET email = LOWER(TRIM(email))
  WHERE email <> LOWER(TRIM(email));

  RAISE NOTICE 'Publisher emails normalised. Rows updated: %', (SELECT COUNT(*) FROM publishers WHERE email <> LOWER(TRIM(email)));
END $$;
