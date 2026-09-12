-- 0014_predicate_domain_range (up)
--
-- What a predicate is allowed to connect.
--
-- The vocabulary has always been untyped: "Born in" accepted an organization
-- and "Located in" accepted a person, silently, because nothing anywhere said
-- which kinds a verb joins. A dissertation's relationship graph is only worth
-- reading if its edges mean what they say, and a mistyped edge is not visibly
-- wrong afterwards -- it is simply a false claim sitting in the record.
--
-- Two SET columns rather than a join table: the vocabulary is ~22 rows, the
-- kinds are a fixed list (LINKABLE_KINDS in src/content/relationships.ts), and
-- MySQL validates membership for us. The cost is that adding a linkable kind
-- later is an ALTER, which is the right amount of friction for a decision that
-- also needs code.
--
-- NULL means "unconstrained", and it is the default, so:
--
--   * every predicate that exists keeps behaving exactly as it does today
--     until this migration's seed narrows it, and
--   * a predicate the operator adds later is unconstrained until they say
--     otherwise, rather than being unusable until they do.
--
-- Nothing is validated retroactively. Edges already recorded stay exactly as
-- they are, whatever they connect: this constrains what may be asserted from
-- now on, and re-deciding the past is not a migration's business.
--
-- Re-runnable, per the rule in CLAUDE.md: MySQL commits implicitly around DDL,
-- so a file that fails halfway cannot roll back and must be safe to run again.
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS, so the ALTER is guarded by a look
-- at information_schema and run through PREPARE.

SET @ddl := (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE relationship_predicate
       ADD COLUMN domain_kinds
         SET(''person'', ''organization'', ''place'', ''event'', ''artifact'') NULL
         AFTER is_symmetric,
       ADD COLUMN range_kinds
         SET(''person'', ''organization'', ''place'', ''event'', ''artifact'') NULL
         AFTER domain_kinds',
    'DO 0')
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'relationship_predicate'
     AND COLUMN_NAME = 'domain_kinds'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- --------------------------------------------------------------------------
-- The seed
-- --------------------------------------------------------------------------
--
-- Matched on `code` and written only where both columns are still NULL, which
-- makes this re-runnable AND makes it defer to the operator: a constraint
-- edited in /admin/vocabulary is never overwritten by re-running migrations.
--
-- The values are deliberately generous. Refusal is now hard, so a domain or
-- range that is too narrow blocks a claim the sources actually support, which
-- is a worse failure than an odd edge nobody would have entered anyway. Where
-- a verb plausibly reads both ways round -- an organization part of an
-- organization, a place within a place -- both are listed.
--
-- `associated_with` is left unconstrained on purpose. It is the escape hatch
-- for a connection the vocabulary has no verb for, and typing it would remove
-- the only way to record one.

UPDATE relationship_predicate SET domain_kinds = 'person,organization', range_kinds = 'organization'
 WHERE code = 'member_of' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person,organization', range_kinds = 'person,organization'
 WHERE code = 'employed_by' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person', range_kinds = 'person'
 WHERE code = 'family_of' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person', range_kinds = 'place'
 WHERE code = 'born_in' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person', range_kinds = 'place'
 WHERE code = 'died_in' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'organization,place,event,artifact', range_kinds = 'place'
 WHERE code = 'located_in' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person,organization', range_kinds = 'event'
 WHERE code = 'participated_in' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'artifact', range_kinds = 'person,organization'
 WHERE code = 'created_by' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'event', range_kinds = 'place,organization'
 WHERE code = 'held_at' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'artifact', range_kinds = 'person,organization,place,event'
 WHERE code = 'depicts' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'artifact', range_kinds = 'person,organization,place,event'
 WHERE code = 'mentions' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'person,organization', range_kinds = 'person,organization'
 WHERE code = 'succeeded_by' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person', range_kinds = 'organization'
 WHERE code = 'held_office_in' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person', range_kinds = 'organization,event'
 WHERE code = 'commanded' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'person,organization', range_kinds = 'person,organization'
 WHERE code = 'reported_to' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person,organization', range_kinds = 'event'
 WHERE code = 'organized' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person,organization', range_kinds = 'event'
 WHERE code = 'attended' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'person,organization,event', range_kinds = 'person,organization,place'
 WHERE code = 'targeted' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate SET domain_kinds = 'person', range_kinds = 'event'
 WHERE code = 'witnessed' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'person,organization,event', range_kinds = 'event'
 WHERE code = 'caused' AND domain_kinds IS NULL AND range_kinds IS NULL;

UPDATE relationship_predicate
   SET domain_kinds = 'organization,place,event', range_kinds = 'organization,place,event'
 WHERE code = 'part_of' AND domain_kinds IS NULL AND range_kinds IS NULL;

-- Written by setEventBounds rather than by the relationship form, and always
-- event to event. Recorded here so the vocabulary screen shows the truth about
-- it rather than a blank.
UPDATE relationship_predicate SET domain_kinds = 'event', range_kinds = 'event'
 WHERE code = 'happened_after' AND domain_kinds IS NULL AND range_kinds IS NULL;
