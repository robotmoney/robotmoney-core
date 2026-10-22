-- Canonical: docs/architecture.md §5.2 (ACL-9), docs/technical/explorer-schema-decisions.md §3.4
-- Implements: core issue 1891 (SS-1019-8, RS-1019-18) — agent identity is (address, registration),
-- and the gateway system is indexed independently of the vaults system.
--
-- A registration is derived from the event position that starts it. Event primary keys do not
-- change. Three columns are added to `agent_policies` and `agent_deposits`:
--
--   gateway                the gateway deployment that emitted the row (NULL when it cannot be known)
--   registration_block     block of the event that started the row's registration
--   registration_log_index log index of that event
--
-- and one to `agent_policies`:
--
--   event_kind             'authorized' | 'revoked' | 'transferred'. 'transferred' is the historical
--                          AgentOwnershipTransferred event of old deployments: it keeps the
--                          registration and names the new owner. Earlier rows keep their owner.
--
-- Registration rule, applied to the rows of one (chain_id, gateway, agent) in (block_number,
-- log_index) order. A row starts a new registration when it is the first row, when the previous row
-- is a revoke, or when it is an authorization and the previous row had expired at this row's block
-- timestamp. Any other row belongs to the registration of the row before it, so `setPolicy`
-- updates stay inside their registration. The indexer applies the same rule when it inserts a row,
-- so a rollback and replay reproduces the same boundaries.
--
-- Deposits take the registration of the latest policy row at or before them, unless that row is a
-- revoke. A deposit with no such row keeps NULL: nothing fabricates an owner for it.

ALTER TABLE agent_policies
    ADD COLUMN IF NOT EXISTS gateway                BYTEA,
    ADD COLUMN IF NOT EXISTS event_kind             TEXT,
    ADD COLUMN IF NOT EXISTS registration_block     BIGINT,
    ADD COLUMN IF NOT EXISTS registration_log_index INTEGER;

ALTER TABLE agent_deposits
    ADD COLUMN IF NOT EXISTS gateway                BYTEA,
    ADD COLUMN IF NOT EXISTS registration_block     BIGINT,
    ADD COLUMN IF NOT EXISTS registration_log_index INTEGER;

-- Old rows do not record their emitter. A chain with exactly one gateway contract row names it.
UPDATE agent_policies p SET gateway = g.address
FROM (
    SELECT chain_id, (array_agg(address))[1] AS address
    FROM contracts WHERE kind = 'gateway'
    GROUP BY chain_id HAVING COUNT(*) = 1
) g
WHERE p.chain_id = g.chain_id AND p.gateway IS NULL;

UPDATE agent_deposits d SET gateway = g.address
FROM (
    SELECT chain_id, (array_agg(address))[1] AS address
    FROM contracts WHERE kind = 'gateway'
    GROUP BY chain_id HAVING COUNT(*) = 1
) g
WHERE d.chain_id = g.chain_id AND d.gateway IS NULL;

-- Prerequisite of the replay below. Whether a re-authorization starts a new registration depends on the
-- block timestamp of the row, because the row before it may have expired. The indexer stores the header of
-- every block that has a watched log, so a policy row after the first of its agent always has one. When
-- one is missing the index was built or edited in a way this backfill cannot trust, and guessing would
-- attach deposits to the wrong owner. Refuse, and let the operator rebuild the index
-- (docs/operations/explorer-db-rebuild.md). The transaction rolls back and the schema stays at 0030.
DO $$
DECLARE
    missing BIGINT;
BEGIN
    SELECT COUNT(*) INTO missing
    FROM (
        SELECT p.chain_id, p.block_number,
               row_number() OVER (
                   PARTITION BY p.chain_id, p.gateway, p.agent
                   ORDER BY p.block_number, p.log_index) AS rn
        FROM agent_policies p
    ) q
    WHERE q.rn > 1
      AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE b.chain_id = q.chain_id AND b.block_number = q.block_number);
    IF missing > 0 THEN
        RAISE EXCEPTION
            'cannot derive agent registrations: % agent_policies rows sit in blocks with no stored header; rebuild the index (docs/operations/explorer-db-rebuild.md)',
            missing;
    END IF;
END
$$;

-- Classify and group the existing policy rows. An old transfer row is a non-revoked row that follows a
-- non-revoked row, names a different owner and repeats every policy field of the row before it.
WITH ordered AS (
    SELECT p.chain_id, p.gateway, p.agent, p.block_number, p.log_index, p.revoked,
           lag(p.revoked)         OVER w AS prev_revoked,
           lag(p.owner)           OVER w AS prev_owner,
           lag(p.valid_until)     OVER w AS prev_valid_until,
           lag(p.max_per_payment) OVER w AS prev_max_per_payment,
           lag(p.max_per_window)  OVER w AS prev_max_per_window,
           lag(p.share_receiver)  OVER w AS prev_share_receiver,
           row_number() OVER w AS rn,
           p.owner, p.valid_until, p.max_per_payment, p.max_per_window, p.share_receiver,
           (SELECT b.timestamp FROM blocks b
             WHERE b.chain_id = p.chain_id AND b.block_number = p.block_number) AS block_ts
    FROM agent_policies p
    WINDOW w AS (PARTITION BY p.chain_id, p.gateway, p.agent ORDER BY p.block_number, p.log_index)
), kinded AS (
    SELECT o.*,
           CASE
             WHEN o.revoked THEN 'revoked'
             WHEN o.rn > 1 AND o.prev_revoked = FALSE
                  AND o.owner IS DISTINCT FROM o.prev_owner
                  AND o.valid_until IS NOT DISTINCT FROM o.prev_valid_until
                  AND o.max_per_payment IS NOT DISTINCT FROM o.prev_max_per_payment
                  AND o.max_per_window IS NOT DISTINCT FROM o.prev_max_per_window
                  AND o.share_receiver IS NOT DISTINCT FROM o.prev_share_receiver
               THEN 'transferred'
             ELSE 'authorized'
           END AS kind
    FROM ordered o
), starts AS (
    SELECT k.chain_id, k.gateway, k.agent, k.block_number, k.log_index, k.kind,
           CASE WHEN k.rn = 1
                  OR k.prev_revoked
                  OR (k.kind = 'authorized'
                      AND k.prev_valid_until IS NOT NULL
                      AND k.block_ts IS NOT NULL
                      AND k.prev_valid_until < k.block_ts)
                THEN k.block_number::BIGINT * 4294967296 + k.log_index
           END AS start_key
    FROM kinded k
), grouped AS (
    SELECT s.chain_id, s.block_number, s.log_index, s.kind,
           max(s.start_key) OVER (
               PARTITION BY s.chain_id, s.gateway, s.agent
               ORDER BY s.block_number, s.log_index
           ) AS reg_key
    FROM starts s
)
UPDATE agent_policies p
SET event_kind             = g.kind,
    registration_block     = g.reg_key / 4294967296,
    registration_log_index = (g.reg_key % 4294967296)::INTEGER
FROM grouped g
WHERE p.chain_id = g.chain_id AND p.block_number = g.block_number AND p.log_index = g.log_index;

-- Associate each existing deposit with the registration live at its event position.
UPDATE agent_deposits d
SET registration_block     = r.registration_block,
    registration_log_index = r.registration_log_index
FROM (
    SELECT d2.chain_id, d2.block_number, d2.log_index,
           prev.registration_block, prev.registration_log_index
    FROM agent_deposits d2
    JOIN LATERAL (
        SELECT p.revoked, p.registration_block, p.registration_log_index
        FROM agent_policies p
        WHERE p.chain_id = d2.chain_id
          AND p.gateway IS NOT DISTINCT FROM d2.gateway
          AND p.agent = d2.agent
          AND (p.block_number, p.log_index) < (d2.block_number, d2.log_index)
        ORDER BY p.block_number DESC, p.log_index DESC
        LIMIT 1
    ) prev ON TRUE
    WHERE prev.revoked = FALSE
) r
WHERE d.chain_id = r.chain_id AND d.block_number = r.block_number AND d.log_index = r.log_index;

CREATE INDEX IF NOT EXISTS agent_policies_registration_idx
    ON agent_policies(chain_id, gateway, agent, registration_block, registration_log_index);
CREATE INDEX IF NOT EXISTS agent_deposits_registration_idx
    ON agent_deposits(chain_id, gateway, agent, registration_block, registration_log_index);
