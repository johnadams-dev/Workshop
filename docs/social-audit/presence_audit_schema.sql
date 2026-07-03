-- ============================================================
-- Online Presence Audit — results table
-- One row per audit run. Internal agents link to your existing
-- `agents` table; external agents are denormalized inline.
-- ============================================================

CREATE TABLE presence_audit_results (
    id                       BIGSERIAL PRIMARY KEY,
    run_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Exactly one of these identity paths is populated
    agent_id                 BIGINT REFERENCES agents(id),   -- internal (Adams, Cameron)
    external_name            TEXT,                            -- external agents only
    external_brokerage       TEXT,
    external_city            TEXT,

    overall_score            SMALLINT NOT NULL,
    social_media_score       SMALLINT,
    reviews_score            SMALLINT,
    platform_profiles_score  SMALLINT,
    local_seo_score          SMALLINT,
    ai_search_score          SMALLINT,
    brand_consistency_score  SMALLINT,
    compliance_score         SMALLINT,

    red_flag_count           SMALLINT NOT NULL DEFAULT 0,

    CONSTRAINT chk_one_identity CHECK (
        (agent_id IS NOT NULL AND external_name IS NULL)
        OR
        (agent_id IS NULL AND external_name IS NOT NULL)
    )
);

CREATE INDEX idx_par_agent_id   ON presence_audit_results (agent_id);
CREATE INDEX idx_par_run_at     ON presence_audit_results (run_at);
CREATE INDEX idx_par_external   ON presence_audit_results (external_brokerage, external_city, external_name);


-- ============================================================
-- Latest score per agent — the basis for all benchmarking.
-- Identity key: agent_id for internal, name+brokerage+city for external.
-- External audits are expected to be one-off; this dedup logic is just
-- a safety net in case the same external agent is accidentally run twice,
-- not a feature for tracking external agents over time.
-- ============================================================

CREATE OR REPLACE VIEW presence_audit_latest AS
WITH ranked AS (
    SELECT *,
        ROW_NUMBER() OVER (
            PARTITION BY COALESCE(
                agent_id::text,
                external_name || '|' || external_brokerage || '|' || external_city
            )
            ORDER BY run_at DESC
        ) AS rn
    FROM presence_audit_results
)
SELECT * FROM ranked WHERE rn = 1;


-- ============================================================
-- Global benchmarks — average and top-10% per category,
-- across every agent (internal + external) we've ever audited.
-- ============================================================

SELECT
    AVG(overall_score)                                              AS avg_overall,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY overall_score)       AS p90_overall,
    AVG(social_media_score)                                         AS avg_social,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY social_media_score) AS p90_social,
    AVG(reviews_score)                                              AS avg_reviews,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY reviews_score)      AS p90_reviews,
    AVG(platform_profiles_score)                                    AS avg_platform,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY platform_profiles_score) AS p90_platform,
    AVG(local_seo_score)                                            AS avg_local_seo,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY local_seo_score)    AS p90_local_seo,
    AVG(ai_search_score)                                            AS avg_ai_search,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ai_search_score)    AS p90_ai_search,
    AVG(brand_consistency_score)                                    AS avg_brand,
    PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY brand_consistency_score) AS p90_brand
FROM presence_audit_latest;


-- ============================================================
-- Adams, Cameron & Co. company average (internal agents only)
-- ============================================================

SELECT
    AVG(overall_score) AS company_avg_overall,
    AVG(social_media_score) AS company_avg_social,
    AVG(reviews_score) AS company_avg_reviews,
    AVG(platform_profiles_score) AS company_avg_platform,
    AVG(local_seo_score) AS company_avg_local_seo,
    AVG(ai_search_score) AS company_avg_ai_search,
    AVG(brand_consistency_score) AS company_avg_brand
FROM presence_audit_latest
WHERE agent_id IS NOT NULL;


-- ============================================================
-- Office average (requires agents.office_id in your existing table)
-- ============================================================

SELECT
    a.office_id,
    AVG(p.overall_score) AS office_avg_overall,
    AVG(p.social_media_score) AS office_avg_social,
    AVG(p.reviews_score) AS office_avg_reviews,
    AVG(p.platform_profiles_score) AS office_avg_platform,
    AVG(p.local_seo_score) AS office_avg_local_seo,
    AVG(p.ai_search_score) AS office_avg_ai_search,
    AVG(p.brand_consistency_score) AS office_avg_brand
FROM presence_audit_latest p
JOIN agents a ON a.id = p.agent_id
WHERE a.office_id = $1
GROUP BY a.office_id;


-- ============================================================
-- One agent's own history over time (improvement tracking)
-- ============================================================

SELECT run_at, overall_score, social_media_score, reviews_score,
       platform_profiles_score, local_seo_score, ai_search_score,
       brand_consistency_score, compliance_score, red_flag_count
FROM presence_audit_results
WHERE agent_id = $1
ORDER BY run_at ASC;
