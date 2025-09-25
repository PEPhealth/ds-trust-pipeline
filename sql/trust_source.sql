-- trust_source.sql
-- Note: :run_date is injected by Step Functions (YYYY-MM-DD). We make it optional for easy testing.
--      If :run_date is null or empty, we just run for the last 7 days as a fallback.

WITH src AS (
  SELECT
    c.comment_unique_key,
    c.cleaned_comment,
    CAST(f.posted_date AS date) AS posted_date
  FROM legacy.all_cleaned_comments c
  JOIN legacy.all_comments_fact f
    ON c.comment_unique_key = f.comment_unique_key
  WHERE f.up_id = 7168 --tanner health
    AND c.cleaned_comment IS NOT NULL
    --AND CAST(f.posted_date AS date) = :run_date
),
ranked AS (
  SELECT
    comment_unique_key,
    cleaned_comment,
    posted_date,
    ROW_NUMBER() OVER (ORDER BY posted_date DESC, comment_unique_key) AS rn
  FROM src
)
SELECT
  comment_unique_key,
  posted_date,
  cleaned_comment
FROM ranked
WHERE rn <= 20; -- keep small for smoke test
--LIMIT 20;  -- remove later
