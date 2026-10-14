import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  DecisionTraceSchema,
  EvidenceItemSchema,
  EvaluationContractSchema,
  ExperimentRecordSchema,
  GoalRevisionSchema,
  PlayPromotionSchema,
  ReceiptSchema,
  SkillVersionSchema,
  TaskDefinitionSchema,
  nowIso,
  sha256,
  type DecisionTrace,
  type EvidenceItem,
  type EvaluationContract,
  type ExperimentRecord,
  type GoalRevision,
  type GoalTaskDisposition,
  type LifecycleState,
  type PlayPromotion,
  type Receipt,
  type ReceiptAttachInput,
  type SkillEvidenceState,
  type SkillVersion,
  type SourceHealth,
  type TaskDefinition,
  type TaskStatus,
  type VenturePack
} from "@opspot/contracts";

const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "core venture lifecycle task outbox schema",
    sql: `
      CREATE TABLE ventures (
        id TEXT PRIMARY KEY CHECK (id LIKE 'venture_%'),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        owning_repo TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL,
        current_pack_hash TEXT,
        current_pack_revision_id TEXT,
        kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE pack_revisions (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        pack_json TEXT NOT NULL,
        source_path TEXT NOT NULL,
        migrated_from TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, canonical_hash),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE source_snapshots (
        venture_id TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        content_hash TEXT,
        actual_revision TEXT,
        message TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (venture_id, source_ref),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE evidence (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        type TEXT NOT NULL,
        proof_tier TEXT NOT NULL,
        authority TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        expires_at TEXT,
        status TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, type, content_hash),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE transition_requests (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        expected_state TEXT NOT NULL,
        target_state TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        requesting_task_id TEXT,
        requesting_agent TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        approval_id TEXT,
        idempotency_key TEXT NOT NULL,
        actor TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        receipt_id TEXT,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE plays (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        definition_json TEXT NOT NULL,
        reusable INTEGER NOT NULL CHECK (reusable IN (0,1)),
        promotion_evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id, version),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE tasks (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        play_id TEXT,
        purpose TEXT NOT NULL,
        owner_role TEXT NOT NULL,
        mode TEXT NOT NULL,
        gate_class TEXT NOT NULL,
        status TEXT NOT NULL,
        expected_proof TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        cancelled_at TEXT,
        dead_letter_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE task_dependencies (
        venture_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        PRIMARY KEY (venture_id, task_id, depends_on_task_id),
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, depends_on_task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT,
        CHECK (task_id <> depends_on_task_id)
      );

      CREATE TABLE jobs (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, task_id, kind),
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE dispatches (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        owner_role TEXT NOT NULL,
        status TEXT NOT NULL,
        external_task_id TEXT,
        external_run_id TEXT,
        result_json TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, task_id, adapter),
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE receipts (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT,
        dispatch_id TEXT,
        proof_tier TEXT NOT NULL,
        outcome TEXT NOT NULL,
        actor TEXT NOT NULL,
        adapter TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, content_hash),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, dispatch_id) REFERENCES dispatches(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE approvals (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        packet_json TEXT NOT NULL,
        approver TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE metrics (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        value REAL,
        unit TEXT NOT NULL,
        status TEXT NOT NULL,
        source_ref TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE founder_interventions (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT,
        gate_class TEXT NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        PRIMARY KEY (venture_id, id),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE cost_entries (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        provider TEXT NOT NULL,
        source_ref TEXT,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE payment_observations (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_cents INTEGER,
        currency TEXT,
        observed_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fixture INTEGER NOT NULL DEFAULT 0 CHECK (fixture IN (0,1)),
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, provider_event_id),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE fulfillment_events (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        authority_event_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        status TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fixture INTEGER NOT NULL DEFAULT 0 CHECK (fixture IN (0,1)),
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, authority_event_id),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE audit_events (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TRIGGER audit_events_immutable_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
      CREATE TRIGGER audit_events_immutable_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are immutable'); END;
      CREATE TRIGGER receipts_immutable_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;
      CREATE TRIGGER receipts_immutable_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;

      CREATE INDEX jobs_ready_idx ON jobs(status, available_at);
      CREATE INDEX tasks_status_idx ON tasks(venture_id, status);
      CREATE INDEX evidence_type_idx ON evidence(venture_id, type, status);
      CREATE INDEX audit_entity_idx ON audit_events(venture_id, entity_type, entity_id, occurred_at);
    `
  },
  {
    version: 2,
    name: "immutable goal evaluation experiment and skill evidence schema",
    sql: `
      CREATE TABLE goal_revisions (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        canonical_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        supersedes_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, revision),
        UNIQUE (venture_id, canonical_hash),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, supersedes_id) REFERENCES goal_revisions(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE goal_revision_receipts (
        venture_id TEXT NOT NULL,
        goal_revision_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        binding_kind TEXT NOT NULL,
        PRIMARY KEY (venture_id, goal_revision_id, receipt_id, binding_kind),
        FOREIGN KEY (venture_id, goal_revision_id) REFERENCES goal_revisions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, receipt_id) REFERENCES receipts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE decision_traces (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        goal_revision_id TEXT,
        evaluation_contract_id TEXT,
        pack_revision_id TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, canonical_hash),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, goal_revision_id) REFERENCES goal_revisions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, evaluation_contract_id) REFERENCES evaluation_contracts(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, pack_revision_id) REFERENCES pack_revisions(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE decision_trace_receipts (
        venture_id TEXT NOT NULL,
        decision_trace_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        binding_kind TEXT NOT NULL,
        PRIMARY KEY (venture_id, decision_trace_id, receipt_id, binding_kind),
        FOREIGN KEY (venture_id, decision_trace_id) REFERENCES decision_traces(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, receipt_id) REFERENCES receipts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE evaluation_contracts (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        goal_revision_id TEXT NOT NULL,
        pack_revision_id TEXT NOT NULL,
        skill_version_id TEXT,
        canonical_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        supersedes_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, revision),
        UNIQUE (venture_id, canonical_hash),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, goal_revision_id) REFERENCES goal_revisions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, pack_revision_id) REFERENCES pack_revisions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, skill_version_id) REFERENCES skill_versions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, supersedes_id) REFERENCES evaluation_contracts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE evaluation_baseline_receipts (
        venture_id TEXT NOT NULL,
        evaluation_contract_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        binding_kind TEXT NOT NULL,
        PRIMARY KEY (venture_id, evaluation_contract_id, receipt_id, binding_kind),
        FOREIGN KEY (venture_id, evaluation_contract_id) REFERENCES evaluation_contracts(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, receipt_id) REFERENCES receipts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE experiment_records (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        evaluation_contract_id TEXT NOT NULL,
        goal_revision_id TEXT NOT NULL,
        skill_version_id TEXT,
        canonical_hash TEXT NOT NULL,
        disposition TEXT NOT NULL,
        record_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, sequence),
        UNIQUE (venture_id, canonical_hash),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, evaluation_contract_id) REFERENCES evaluation_contracts(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, goal_revision_id) REFERENCES goal_revisions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, skill_version_id) REFERENCES skill_versions(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE experiment_receipts (
        venture_id TEXT NOT NULL,
        experiment_record_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        binding_kind TEXT NOT NULL,
        PRIMARY KEY (venture_id, experiment_record_id, receipt_id, binding_kind),
        FOREIGN KEY (venture_id, experiment_record_id) REFERENCES experiment_records(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, receipt_id) REFERENCES receipts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE skill_versions (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        skill_id TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        semantic_version TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        evidence_state TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        supersedes_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, skill_id, revision),
        UNIQUE (venture_id, canonical_hash),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, supersedes_id) REFERENCES skill_versions(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE skill_version_evaluations (
        skill_venture_id TEXT NOT NULL,
        skill_version_id TEXT NOT NULL,
        evaluation_venture_id TEXT NOT NULL,
        evaluation_contract_id TEXT NOT NULL,
        PRIMARY KEY (skill_venture_id, skill_version_id, evaluation_venture_id, evaluation_contract_id),
        FOREIGN KEY (skill_venture_id, skill_version_id) REFERENCES skill_versions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (evaluation_venture_id, evaluation_contract_id) REFERENCES evaluation_contracts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE skill_version_experiments (
        skill_venture_id TEXT NOT NULL,
        skill_version_id TEXT NOT NULL,
        experiment_venture_id TEXT NOT NULL,
        experiment_record_id TEXT NOT NULL,
        PRIMARY KEY (skill_venture_id, skill_version_id, experiment_venture_id, experiment_record_id),
        FOREIGN KEY (skill_venture_id, skill_version_id) REFERENCES skill_versions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (experiment_venture_id, experiment_record_id) REFERENCES experiment_records(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE skill_version_evidence (
        skill_venture_id TEXT NOT NULL,
        skill_version_id TEXT NOT NULL,
        evidence_venture_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY (skill_venture_id, skill_version_id, evidence_venture_id, evidence_id),
        FOREIGN KEY (skill_venture_id, skill_version_id) REFERENCES skill_versions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (evidence_venture_id, evidence_id) REFERENCES evidence(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE play_promotions (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        play_id TEXT NOT NULL,
        skill_version_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        decision TEXT NOT NULL CHECK (decision IN ('promote','refuse','deprecate')),
        target_state TEXT NOT NULL,
        canonical_hash TEXT NOT NULL,
        record_json TEXT NOT NULL,
        supersedes_id TEXT,
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, play_id, revision),
        UNIQUE (venture_id, canonical_hash),
        UNIQUE (venture_id, idempotency_key),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, skill_version_id) REFERENCES skill_versions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, supersedes_id) REFERENCES play_promotions(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE play_promotion_experiments (
        promotion_venture_id TEXT NOT NULL,
        play_promotion_id TEXT NOT NULL,
        experiment_venture_id TEXT NOT NULL,
        experiment_record_id TEXT NOT NULL,
        PRIMARY KEY (promotion_venture_id, play_promotion_id, experiment_venture_id, experiment_record_id),
        FOREIGN KEY (promotion_venture_id, play_promotion_id) REFERENCES play_promotions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (experiment_venture_id, experiment_record_id) REFERENCES experiment_records(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE play_promotion_evaluations (
        promotion_venture_id TEXT NOT NULL,
        play_promotion_id TEXT NOT NULL,
        evaluation_venture_id TEXT NOT NULL,
        evaluation_contract_id TEXT NOT NULL,
        PRIMARY KEY (promotion_venture_id, play_promotion_id, evaluation_venture_id, evaluation_contract_id),
        FOREIGN KEY (promotion_venture_id, play_promotion_id) REFERENCES play_promotions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (evaluation_venture_id, evaluation_contract_id) REFERENCES evaluation_contracts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE play_promotion_evidence (
        promotion_venture_id TEXT NOT NULL,
        play_promotion_id TEXT NOT NULL,
        evidence_venture_id TEXT NOT NULL,
        evidence_id TEXT NOT NULL,
        PRIMARY KEY (promotion_venture_id, play_promotion_id, evidence_venture_id, evidence_id),
        FOREIGN KEY (promotion_venture_id, play_promotion_id) REFERENCES play_promotions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (evidence_venture_id, evidence_id) REFERENCES evidence(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE play_promotion_receipts (
        promotion_venture_id TEXT NOT NULL,
        play_promotion_id TEXT NOT NULL,
        receipt_venture_id TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        binding_kind TEXT NOT NULL,
        PRIMARY KEY (promotion_venture_id, play_promotion_id, receipt_venture_id, receipt_id, binding_kind),
        FOREIGN KEY (promotion_venture_id, play_promotion_id) REFERENCES play_promotions(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (receipt_venture_id, receipt_id) REFERENCES receipts(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TRIGGER goal_revisions_immutable_update BEFORE UPDATE ON goal_revisions BEGIN SELECT RAISE(ABORT, 'goal revisions are immutable'); END;
      CREATE TRIGGER goal_revisions_immutable_delete BEFORE DELETE ON goal_revisions BEGIN SELECT RAISE(ABORT, 'goal revisions are immutable'); END;
      CREATE TRIGGER goal_revision_receipts_immutable_update BEFORE UPDATE ON goal_revision_receipts BEGIN SELECT RAISE(ABORT, 'goal receipt bindings are immutable'); END;
      CREATE TRIGGER goal_revision_receipts_immutable_delete BEFORE DELETE ON goal_revision_receipts BEGIN SELECT RAISE(ABORT, 'goal receipt bindings are immutable'); END;
      CREATE TRIGGER decision_traces_immutable_update BEFORE UPDATE ON decision_traces BEGIN SELECT RAISE(ABORT, 'decision traces are immutable'); END;
      CREATE TRIGGER decision_traces_immutable_delete BEFORE DELETE ON decision_traces BEGIN SELECT RAISE(ABORT, 'decision traces are immutable'); END;
      CREATE TRIGGER decision_trace_receipts_immutable_update BEFORE UPDATE ON decision_trace_receipts BEGIN SELECT RAISE(ABORT, 'decision trace receipt bindings are immutable'); END;
      CREATE TRIGGER decision_trace_receipts_immutable_delete BEFORE DELETE ON decision_trace_receipts BEGIN SELECT RAISE(ABORT, 'decision trace receipt bindings are immutable'); END;
      CREATE TRIGGER evaluation_contracts_immutable_update BEFORE UPDATE ON evaluation_contracts BEGIN SELECT RAISE(ABORT, 'evaluation contracts are immutable'); END;
      CREATE TRIGGER evaluation_contracts_immutable_delete BEFORE DELETE ON evaluation_contracts BEGIN SELECT RAISE(ABORT, 'evaluation contracts are immutable'); END;
      CREATE TRIGGER evaluation_baseline_receipts_immutable_update BEFORE UPDATE ON evaluation_baseline_receipts BEGIN SELECT RAISE(ABORT, 'evaluation receipt bindings are immutable'); END;
      CREATE TRIGGER evaluation_baseline_receipts_immutable_delete BEFORE DELETE ON evaluation_baseline_receipts BEGIN SELECT RAISE(ABORT, 'evaluation receipt bindings are immutable'); END;
      CREATE TRIGGER experiment_records_immutable_update BEFORE UPDATE ON experiment_records BEGIN SELECT RAISE(ABORT, 'experiment records are immutable'); END;
      CREATE TRIGGER experiment_records_immutable_delete BEFORE DELETE ON experiment_records BEGIN SELECT RAISE(ABORT, 'experiment records are immutable'); END;
      CREATE TRIGGER experiment_receipts_immutable_update BEFORE UPDATE ON experiment_receipts BEGIN SELECT RAISE(ABORT, 'experiment receipt bindings are immutable'); END;
      CREATE TRIGGER experiment_receipts_immutable_delete BEFORE DELETE ON experiment_receipts BEGIN SELECT RAISE(ABORT, 'experiment receipt bindings are immutable'); END;
      CREATE TRIGGER skill_versions_immutable_update BEFORE UPDATE ON skill_versions BEGIN SELECT RAISE(ABORT, 'skill versions are immutable'); END;
      CREATE TRIGGER skill_versions_immutable_delete BEFORE DELETE ON skill_versions BEGIN SELECT RAISE(ABORT, 'skill versions are immutable'); END;
      CREATE TRIGGER skill_version_evaluations_immutable_update BEFORE UPDATE ON skill_version_evaluations BEGIN SELECT RAISE(ABORT, 'skill evaluation bindings are immutable'); END;
      CREATE TRIGGER skill_version_evaluations_immutable_delete BEFORE DELETE ON skill_version_evaluations BEGIN SELECT RAISE(ABORT, 'skill evaluation bindings are immutable'); END;
      CREATE TRIGGER skill_version_experiments_immutable_update BEFORE UPDATE ON skill_version_experiments BEGIN SELECT RAISE(ABORT, 'skill experiment bindings are immutable'); END;
      CREATE TRIGGER skill_version_experiments_immutable_delete BEFORE DELETE ON skill_version_experiments BEGIN SELECT RAISE(ABORT, 'skill experiment bindings are immutable'); END;
      CREATE TRIGGER skill_version_evidence_immutable_update BEFORE UPDATE ON skill_version_evidence BEGIN SELECT RAISE(ABORT, 'skill evidence bindings are immutable'); END;
      CREATE TRIGGER skill_version_evidence_immutable_delete BEFORE DELETE ON skill_version_evidence BEGIN SELECT RAISE(ABORT, 'skill evidence bindings are immutable'); END;
      CREATE TRIGGER play_promotions_immutable_update BEFORE UPDATE ON play_promotions BEGIN SELECT RAISE(ABORT, 'play promotions are immutable'); END;
      CREATE TRIGGER play_promotions_immutable_delete BEFORE DELETE ON play_promotions BEGIN SELECT RAISE(ABORT, 'play promotions are immutable'); END;
      CREATE TRIGGER play_promotion_experiments_immutable_update BEFORE UPDATE ON play_promotion_experiments BEGIN SELECT RAISE(ABORT, 'promotion experiment bindings are immutable'); END;
      CREATE TRIGGER play_promotion_experiments_immutable_delete BEFORE DELETE ON play_promotion_experiments BEGIN SELECT RAISE(ABORT, 'promotion experiment bindings are immutable'); END;
      CREATE TRIGGER play_promotion_evaluations_immutable_update BEFORE UPDATE ON play_promotion_evaluations BEGIN SELECT RAISE(ABORT, 'promotion evaluation bindings are immutable'); END;
      CREATE TRIGGER play_promotion_evaluations_immutable_delete BEFORE DELETE ON play_promotion_evaluations BEGIN SELECT RAISE(ABORT, 'promotion evaluation bindings are immutable'); END;
      CREATE TRIGGER play_promotion_evidence_immutable_update BEFORE UPDATE ON play_promotion_evidence BEGIN SELECT RAISE(ABORT, 'promotion evidence bindings are immutable'); END;
      CREATE TRIGGER play_promotion_evidence_immutable_delete BEFORE DELETE ON play_promotion_evidence BEGIN SELECT RAISE(ABORT, 'promotion evidence bindings are immutable'); END;
      CREATE TRIGGER play_promotion_receipts_immutable_update BEFORE UPDATE ON play_promotion_receipts BEGIN SELECT RAISE(ABORT, 'promotion receipt bindings are immutable'); END;
      CREATE TRIGGER play_promotion_receipts_immutable_delete BEFORE DELETE ON play_promotion_receipts BEGIN SELECT RAISE(ABORT, 'promotion receipt bindings are immutable'); END;

      CREATE INDEX decision_trace_goal_idx ON decision_traces(venture_id, goal_revision_id, created_at);
      CREATE INDEX evaluation_goal_idx ON evaluation_contracts(venture_id, goal_revision_id, created_at);
      CREATE INDEX experiment_eval_idx ON experiment_records(venture_id, evaluation_contract_id, created_at);
      CREATE INDEX skill_name_idx ON skill_versions(venture_id, skill_name, created_at);
    `
  },
  {
    version: 3,
    name: "engine-owned receipt origin provenance",
    sql: `
      DROP TRIGGER receipts_immutable_update;
      ALTER TABLE receipts ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'
        CHECK (origin IN ('dispatch','engine-derived','attached-artifact','fixture','legacy'));
      UPDATE receipts
      SET origin = CASE
        WHEN adapter = 'fixture' THEN 'fixture'
        WHEN dispatch_id IS NOT NULL THEN 'dispatch'
        WHEN adapter = 'lifecycle-engine' THEN 'engine-derived'
        ELSE 'legacy'
      END;
      CREATE TRIGGER receipts_immutable_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts are immutable'); END;
    `
  },
  {
    version: 4,
    name: "immutable task definitions with mutable execution state",
    sql: `
      CREATE TRIGGER tasks_definition_immutable_update
      BEFORE UPDATE ON tasks
      WHEN NEW.venture_id <> OLD.venture_id
        OR NEW.id <> OLD.id
        OR NEW.play_id IS NOT OLD.play_id
        OR NEW.purpose <> OLD.purpose
        OR NEW.owner_role <> OLD.owner_role
        OR NEW.mode <> OLD.mode
        OR NEW.gate_class <> OLD.gate_class
        OR NEW.expected_proof <> OLD.expected_proof
        OR NEW.definition_json <> OLD.definition_json
        OR NEW.action_digest <> OLD.action_digest
        OR NEW.idempotency_key <> OLD.idempotency_key
      BEGIN SELECT RAISE(ABORT, 'task definitions are immutable'); END;
    `
  },
  {
    version: 5,
    name: "workspace ownership and deterministic local workspace",
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY CHECK (id LIKE 'workspace_%'),
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO workspaces(id,slug,name,created_at) VALUES('workspace_local','local','Local workspace',CURRENT_TIMESTAMP);
      ALTER TABLE ventures ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'workspace_local';
      ALTER TABLE ventures ADD COLUMN company_slug TEXT NOT NULL DEFAULT '';
      UPDATE ventures SET company_slug=slug;
      CREATE UNIQUE INDEX ventures_workspace_slug_idx ON ventures(workspace_id, company_slug);
      CREATE TRIGGER ventures_workspace_exists_insert BEFORE INSERT ON ventures
      WHEN NOT EXISTS (SELECT 1 FROM workspaces WHERE id=NEW.workspace_id)
      BEGIN SELECT RAISE(ABORT, 'workspace not found'); END;
      CREATE TRIGGER ventures_workspace_immutable_update BEFORE UPDATE OF workspace_id ON ventures
      WHEN NEW.workspace_id <> OLD.workspace_id
      BEGIN SELECT RAISE(ABORT, 'venture workspace is immutable'); END;
      CREATE TRIGGER workspaces_in_use_delete BEFORE DELETE ON workspaces
      WHEN EXISTS (SELECT 1 FROM ventures WHERE workspace_id=OLD.id)
      BEGIN SELECT RAISE(ABORT, 'workspace is in use'); END;
      CREATE TRIGGER workspaces_id_immutable_update BEFORE UPDATE OF id ON workspaces
      WHEN NEW.id <> OLD.id
      BEGIN SELECT RAISE(ABORT, 'workspace id is immutable'); END;
    `
  },
  {
    version: 6,
    name: "public kernel leases entitlements effects and secret metadata",
    sql: `
      ALTER TABLE ventures ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE ventures ADD COLUMN state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1);
      ALTER TABLE jobs ADD COLUMN lease_token TEXT;
      ALTER TABLE approvals ADD COLUMN resolution_id TEXT;
      ALTER TABLE approvals ADD COLUMN resolved_at TEXT;
      ALTER TABLE approvals ADD COLUMN resolution_actor TEXT;

      CREATE TABLE company_entitlements (
        venture_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        plan TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        model_cost_cap_cents INTEGER NOT NULL CHECK (model_cost_cap_cents >= 0),
        spent_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (spent_cost_cents >= 0),
        reserved_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_cents >= 0),
        provider_event_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE effect_reservations (
        venture_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        effect_type TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        provider_idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','needs-reconciliation','committed')),
        lease_token TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, idempotency_key),
        UNIQUE (venture_id, provider, provider_idempotency_key),
        FOREIGN KEY (venture_id, job_id) REFERENCES jobs(venture_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE secret_metadata (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        provider TEXT NOT NULL,
        purpose TEXT NOT NULL,
        opaque_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active','revoked')),
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        PRIMARY KEY (venture_id, id),
        UNIQUE (venture_id, opaque_ref),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT
      );

      CREATE TABLE secret_envelopes (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        key_id TEXT NOT NULL,
        aad_hash TEXT NOT NULL CHECK (length(aad_hash) = 64),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        FOREIGN KEY (venture_id, id) REFERENCES secret_metadata(venture_id, id) ON DELETE RESTRICT
      );

      CREATE TABLE cost_reservations (
        venture_id TEXT NOT NULL,
        id TEXT NOT NULL,
        task_id TEXT,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        actual_cost_cents INTEGER CHECK (actual_cost_cents IS NULL OR actual_cost_cents >= 0),
        provider TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','settled','released')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (venture_id, id),
        FOREIGN KEY (venture_id) REFERENCES ventures(id) ON DELETE RESTRICT,
        FOREIGN KEY (venture_id, task_id) REFERENCES tasks(venture_id, id) ON DELETE RESTRICT
      );

      CREATE INDEX effect_reservations_job_idx ON effect_reservations(venture_id, job_id, status);
      CREATE INDEX secret_metadata_venture_idx ON secret_metadata(venture_id, status);
      CREATE INDEX cost_reservations_expiry_idx ON cost_reservations(status, expires_at);
      CREATE TRIGGER evidence_immutable_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
      CREATE TRIGGER evidence_immutable_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;
      CREATE TRIGGER cost_entries_immutable_update BEFORE UPDATE ON cost_entries BEGIN SELECT RAISE(ABORT, 'cost entries are immutable'); END;
      CREATE TRIGGER cost_entries_immutable_delete BEFORE DELETE ON cost_entries BEGIN SELECT RAISE(ABORT, 'cost entries are immutable'); END;
    `
  },
  {
    version: 7,
    name: "authoritative entitlement ordering",
    sql: `
      ALTER TABLE company_entitlements ADD COLUMN provider_order INTEGER NOT NULL DEFAULT 0 CHECK (provider_order >= 0);
    `
  }
];

interface VentureRow {
  id: string;
  slug: string;
  company_slug: string;
  name: string;
  owner: string;
  workspace_id: string;
  owning_repo: string;
  lifecycle_state: LifecycleState;
  current_pack_hash: string | null;
  current_pack_revision_id: string | null;
  kill_switch: number;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  venture_id: string;
  id: string;
  status: TaskStatus;
  definition_json: string;
  action_digest: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  venture_id: string;
  id: string;
  task_id: string;
  kind: string;
  status: string;
  payload_json: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  available_at: string;
}

type ImmutableRecordTable =
  | "goal_revisions"
  | "decision_traces"
  | "evaluation_contracts"
  | "experiment_records"
  | "skill_versions"
  | "play_promotions";

type VentureScopedReferenceTable = "evaluation_contracts" | "experiment_records" | "evidence" | "receipts";

type CursorPaginatedTable = "skill_versions" | "play_promotions";

interface CursorListFilter {
  clause: string;
  value: string;
}

interface CursorListQuery {
  cursor?: string;
  limit?: number;
}

export interface StorageCursorPage<T> {
  records: T[];
  nextCursor?: string;
}

export interface SkillVersionListOptions extends CursorListQuery {
  skillId?: string;
  state?: SkillEvidenceState;
}

export type SkillVersionPageOptions = SkillVersionListOptions & { includePageInfo: true };

export interface PlayPromotionListOptions extends CursorListQuery {
  playId?: string;
  skillVersionId?: string;
  state?: SkillEvidenceState;
}

export type PlayPromotionPageOptions = PlayPromotionListOptions & { includePageInfo: true };

interface ImmutableRecordRow {
  id: string;
  venture_id: string;
  canonical_hash: string;
  record_json: string;
  idempotency_key: string;
}

export class StorageIdempotencyConflictError extends Error {
  readonly code = "idempotency-conflict" as const;

  constructor(entity: string, ventureId: string, idempotencyKey: string) {
    super(`idempotency conflict for ${entity}: ${ventureId}/${idempotencyKey}`);
    this.name = "StorageIdempotencyConflictError";
  }
}

export class StorageRevisionConflictError extends Error {
  readonly code = "revision-conflict" as const;

  constructor(entity: string, ventureId: string, expected: number, received: number) {
    super(`revision conflict for ${entity}: ${ventureId}; expected ${expected}, received ${received}`);
    this.name = "StorageRevisionConflictError";
  }
}

export class StorageCursorError extends Error {
  readonly code = "invalid-cursor" as const;

  constructor(entity: string, ventureId: string, cursor: string) {
    super(`invalid ${entity} cursor for requested venture and filter scope: ${ventureId}/${cursor}`);
    this.name = "StorageCursorError";
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export class EngineStorage {
  readonly db: DatabaseSync;
  readonly filename: string;

  constructor(filename: string) {
    this.filename = filename;
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    const applied = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map((row) => row.version)
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      // Some migration-only tests intentionally model just the v4 ventures table.
      // The public kernel migration applies only to a complete engine schema.
      if (migration.version >= 6 && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'").get()) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(migration.version, migration.name, nowIso());
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  integrityCheck(): string {
    return (this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  }

  upsertPack(input: {
    pack: VenturePack;
    workspaceId: string;
    canonicalHash: string;
    canonicalJson: string;
    sourcePath: string;
    migratedFrom?: string;
    revisionId: string;
    createdAt: string;
  }): { created: boolean; revisionId: string } {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM ventures WHERE id=?").get(input.pack.venture.id);
      const storageSlug = input.workspaceId === "workspace_local" ? input.pack.venture.slug : `${input.workspaceId}:${input.pack.venture.slug}`;
      if (!existing) {
        this.db
          .prepare(
            "INSERT INTO ventures(id,slug,company_slug,name,owner,owning_repo,lifecycle_state,workspace_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
          )
          .run(
            input.pack.venture.id,
            storageSlug,
            input.pack.venture.slug,
            input.pack.venture.name,
            input.pack.venture.owner,
            input.pack.venture.owningRepo,
            input.pack.venture.declaredState,
            input.workspaceId,
            input.createdAt,
            input.createdAt
          );
      } else {
        const owner = this.db.prepare("SELECT workspace_id FROM ventures WHERE id=?").get(input.pack.venture.id) as { workspace_id: string };
        if (owner.workspace_id !== input.workspaceId) throw new Error(`workspace access denied for venture: ${input.pack.venture.id}`);
        this.db
          .prepare("UPDATE ventures SET slug=?,company_slug=?,name=?,owner=?,owning_repo=?,updated_at=? WHERE id=?")
          .run(storageSlug, input.pack.venture.slug, input.pack.venture.name, input.pack.venture.owner, input.pack.venture.owningRepo, input.createdAt, input.pack.venture.id);
      }
      const prior = this.db
        .prepare("SELECT id FROM pack_revisions WHERE venture_id=? AND canonical_hash=?")
        .get(input.pack.venture.id, input.canonicalHash) as { id: string } | undefined;
      const revisionId = prior?.id ?? input.revisionId;
      if (!prior) {
        this.db
          .prepare(
            "INSERT INTO pack_revisions(venture_id,id,schema_version,canonical_hash,pack_json,source_path,migrated_from,created_at) VALUES(?,?,?,?,?,?,?,?)"
          )
          .run(
            input.pack.venture.id,
            revisionId,
            input.pack.schemaVersion,
            input.canonicalHash,
            input.canonicalJson,
            input.sourcePath,
            input.migratedFrom ?? null,
            input.createdAt
          );
      }
      this.db
        .prepare("UPDATE ventures SET current_pack_hash=?,current_pack_revision_id=?,updated_at=? WHERE id=?")
        .run(input.canonicalHash, revisionId, input.createdAt, input.pack.venture.id);
      return { created: !prior, revisionId };
    });
  }

  getVenture(ventureId: string): (VentureRow & { pack?: VenturePack }) | undefined {
    const row = this.db.prepare("SELECT * FROM ventures WHERE id=?").get(ventureId) as VentureRow | undefined;
    if (!row) return undefined;
    const packRow = this.db
      .prepare("SELECT pack_json FROM pack_revisions WHERE venture_id=? AND id=?")
      .get(ventureId, row.current_pack_revision_id) as { pack_json: string } | undefined;
    return { ...row, slug: row.company_slug, ...(packRow ? { pack: parseJson<VenturePack>(packRow.pack_json) } : {}) };
  }

  hasPackRevision(ventureId: string, packRevisionId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM pack_revisions WHERE venture_id=? AND id=?").get(ventureId, packRevisionId)
    );
  }

  listVentures(): VentureRow[] {
    return (this.db.prepare("SELECT * FROM ventures ORDER BY workspace_id,company_slug").all() as unknown as VentureRow[]).map((row) => ({
      ...row,
      slug: row.company_slug
    }));
  }

  listVenturesInWorkspace(workspaceId: string): VentureRow[] {
    return (this.db.prepare("SELECT * FROM ventures WHERE workspace_id=? ORDER BY company_slug").all(workspaceId) as unknown as VentureRow[]).map((row) => ({
      ...row,
      slug: row.company_slug
    }));
  }

  isVentureInWorkspace(workspaceId: string, ventureId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM ventures WHERE id=? AND workspace_id=?").get(ventureId, workspaceId));
  }

  ensureWorkspace(workspaceId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO workspaces(id,slug,name,created_at) VALUES(?,?,?,?)")
      .run(workspaceId, workspaceId.replace(/^workspace_/, ""), workspaceId, nowIso());
  }

  workspaceForVenture(ventureId: string): string | undefined {
    return (this.db.prepare("SELECT workspace_id FROM ventures WHERE id=?").get(ventureId) as { workspace_id: string } | undefined)?.workspace_id;
  }

  saveSourceHealth(ventureId: string, items: SourceHealth[]): void {
    this.transaction(() => {
      const statement = this.db.prepare(
        `INSERT INTO source_snapshots(venture_id,source_ref,status,observed_at,content_hash,actual_revision,message,metadata_json)
         VALUES(?,?,?,?,?,?,?,'{}')
         ON CONFLICT(venture_id,source_ref) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at,
           content_hash=excluded.content_hash,actual_revision=excluded.actual_revision,message=excluded.message`
      );
      for (const item of items) {
        if (item.ventureId !== ventureId) throw new Error("cross-venture source health write rejected");
        statement.run(ventureId, item.sourceRef, item.status, item.observedAt, item.contentHash ?? null, item.actualRevision ?? null, item.message);
      }
    });
  }

  listSourceHealth(ventureId: string): SourceHealth[] {
    return (this.db.prepare("SELECT * FROM source_snapshots WHERE venture_id=? ORDER BY source_ref").all(ventureId) as any[]).map((row) => ({
      ventureId: row.venture_id,
      sourceRef: row.source_ref,
      status: row.status,
      observedAt: row.observed_at,
      ...(row.content_hash ? { contentHash: row.content_hash } : {}),
      ...(row.actual_revision ? { actualRevision: row.actual_revision } : {}),
      message: row.message
    }));
  }

  addEvidence(item: EvidenceItem): { created: boolean; id: string } {
    EvidenceItemSchema.parse(item);
    const prior = this.db
      .prepare("SELECT id FROM evidence WHERE venture_id=? AND type=? AND content_hash=?")
      .get(item.ventureId, item.type, item.contentHash) as { id: string } | undefined;
    if (prior) return { created: false, id: prior.id };
    this.db
      .prepare(
        "INSERT INTO evidence(venture_id,id,type,proof_tier,authority,source_ref,observed_at,expires_at,status,content_hash,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        item.ventureId,
        item.id,
        item.type,
        item.proofTier,
        item.authority,
        item.sourceRef,
        item.observedAt,
        item.expiresAt ?? null,
        item.status,
        item.contentHash,
        JSON.stringify(item.metadata)
      );
    return { created: true, id: item.id };
  }

  listEvidence(ventureId: string): EvidenceItem[] {
    return (this.db.prepare("SELECT * FROM evidence WHERE venture_id=? ORDER BY observed_at,id").all(ventureId) as any[]).map((row) =>
      EvidenceItemSchema.parse({
        id: row.id,
        ventureId: row.venture_id,
        type: row.type,
        proofTier: row.proof_tier,
        authority: row.authority,
        sourceRef: row.source_ref,
        observedAt: row.observed_at,
        ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
        status: row.status,
        contentHash: row.content_hash,
        metadata: parseJson(row.metadata_json)
      })
    );
  }

  setLifecycleState(ventureId: string, expected: LifecycleState, target: LifecycleState, updatedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE ventures SET lifecycle_state=?,updated_at=? WHERE id=? AND lifecycle_state=?")
      .run(target, updatedAt, ventureId, expected);
    return Number(result.changes) === 1;
  }

  findTransitionByIdempotency(ventureId: string, idempotencyKey: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM transition_requests WHERE venture_id=? AND idempotency_key=?").get(ventureId, idempotencyKey) as any;
  }

  recordTransition(input: {
    venture_id: string;
    id: string;
    expected_state: string;
    target_state: string;
    evidence_ids_json: string;
    requesting_task_id: string | null;
    requesting_agent: string;
    policy_json: string;
    approval_id: string | null;
    idempotency_key: string;
    actor: string;
    requested_at: string;
    outcome: string;
    reason: string;
    receipt_id: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO transition_requests(venture_id,id,expected_state,target_state,evidence_ids_json,requesting_task_id,requesting_agent,policy_json,
          approval_id,idempotency_key,actor,requested_at,outcome,reason,receipt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        input.venture_id,
        input.id,
        input.expected_state,
        input.target_state,
        input.evidence_ids_json,
        input.requesting_task_id,
        input.requesting_agent,
        input.policy_json,
        input.approval_id,
        input.idempotency_key,
        input.actor,
        input.requested_at,
        input.outcome,
        input.reason,
        input.receipt_id
      );
  }

  addAuditEvent(input: { ventureId: string; id: string; eventType: string; actor: string; entityType: string; entityId: string; payload: unknown; occurredAt: string }): void {
    this.db
      .prepare("INSERT OR IGNORE INTO audit_events(venture_id,id,event_type,actor,entity_type,entity_id,payload_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(input.ventureId, input.id, input.eventType, input.actor, input.entityType, input.entityId, JSON.stringify(input.payload), input.occurredAt);
  }

  listAuditEvents(ventureId: string): any[] {
    return (this.db.prepare("SELECT * FROM audit_events WHERE venture_id=? ORDER BY occurred_at,id").all(ventureId) as any[]).map((row) => ({
      ...row,
      payload: parseJson(row.payload_json)
    }));
  }

  private listImmutableCursorPage<T>(
    table: CursorPaginatedTable,
    entity: string,
    ventureId: string,
    filters: readonly CursorListFilter[],
    options: CursorListQuery,
    parse: (value: unknown) => T
  ): StorageCursorPage<T> {
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError(`${entity} list limit must be an integer between 1 and 200`);
    }
    if (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 500)) {
      throw new StorageCursorError(entity, ventureId, options.cursor);
    }

    const clauses = ["venture_id=?", ...filters.map((filter) => filter.clause)];
    const parameters: Array<string | number> = [ventureId, ...filters.map((filter) => filter.value)];
    if (options.cursor) {
      const cursorRow = this.db
        .prepare(`SELECT created_at FROM ${table} WHERE ${clauses.join(" AND ")} AND id=?`)
        .get(...parameters, options.cursor) as { created_at: string } | undefined;
      if (!cursorRow) throw new StorageCursorError(entity, ventureId, options.cursor);
      clauses.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(cursorRow.created_at, cursorRow.created_at, options.cursor);
    }

    parameters.push(limit + 1);
    const rows = this.db
      .prepare(`SELECT id,record_json FROM ${table} WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ?`)
      .all(...parameters) as Array<{ id: string; record_json: string }>;
    const hasMore = rows.length > limit;
    const selectedRows = rows.slice(0, limit);
    const records = selectedRows.map((row) => parse(parseJson(row.record_json)));
    return {
      records,
      ...(hasMore ? { nextCursor: selectedRows.at(-1)!.id } : {})
    };
  }

  private replayImmutable<T>(
    table: ImmutableRecordTable,
    entity: string,
    ventureId: string,
    idempotencyKey: string,
    canonicalHash: string,
    parse: (value: unknown) => T
  ): { created: false; record: T } | undefined {
    const byKey = this.db
      .prepare(`SELECT id,venture_id,canonical_hash,record_json,idempotency_key FROM ${table} WHERE venture_id=? AND idempotency_key=?`)
      .get(ventureId, idempotencyKey) as ImmutableRecordRow | undefined;
    if (byKey) {
      if (byKey.canonical_hash !== canonicalHash) {
        throw new StorageIdempotencyConflictError(entity, ventureId, idempotencyKey);
      }
      return { created: false, record: parse(parseJson(byKey.record_json)) };
    }

    const byHash = this.db
      .prepare(`SELECT id,venture_id,canonical_hash,record_json,idempotency_key FROM ${table} WHERE venture_id=? AND canonical_hash=?`)
      .get(ventureId, canonicalHash) as ImmutableRecordRow | undefined;
    if (byHash) {
      // A canonical record is bound to the key that first created it. Silently
      // aliasing a second key would let that unpersisted key be reused later
      // with different content, defeating exact idempotency semantics.
      throw new StorageIdempotencyConflictError(entity, ventureId, idempotencyKey);
    }
    return undefined;
  }

  private requireLocalReference(table: VentureScopedReferenceTable, ventureId: string, id: string, label: string): void {
    if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE venture_id=? AND id=?`).get(ventureId, id)) {
      throw new Error(`${label} not found or belongs to another venture: ${ventureId}/${id}`);
    }
  }

  private resolveReferenceVenture(
    table: VentureScopedReferenceTable,
    id: string,
    allowedVentureIds: readonly string[],
    label: string
  ): string {
    const matches = [...new Set(allowedVentureIds)].filter((ventureId) =>
      Boolean(this.db.prepare(`SELECT 1 FROM ${table} WHERE venture_id=? AND id=?`).get(ventureId, id))
    );
    if (matches.length === 0) throw new Error(`${label} not found in an allowed venture: ${id}`);
    if (matches.length > 1) throw new Error(`${label} is ambiguous across ventures: ${id}`);
    return matches[0]!;
  }

  private requireSameWorkspace(ventureId: string, referencedVentureIds: readonly string[]): void {
    const workspaceId = this.workspaceForVenture(ventureId);
    if (!workspaceId) throw new Error(`venture not found: ${ventureId}`);
    for (const referencedVentureId of new Set(referencedVentureIds)) {
      if (!this.isVentureInWorkspace(workspaceId, referencedVentureId)) throw new Error("workspace access denied");
    }
  }

  nextGoalRevision(ventureId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM goal_revisions WHERE venture_id=?").get(ventureId) as {
      next: number;
    };
    return row.next;
  }

  getGoalRevision(ventureId: string, goalRevisionId: string): GoalRevision | undefined {
    const row = this.db.prepare("SELECT record_json FROM goal_revisions WHERE venture_id=? AND id=?").get(ventureId, goalRevisionId) as
      | { record_json: string }
      | undefined;
    return row ? GoalRevisionSchema.parse(parseJson(row.record_json)) : undefined;
  }

  getLatestGoalRevision(ventureId: string): GoalRevision | undefined {
    const row = this.db.prepare("SELECT record_json FROM goal_revisions WHERE venture_id=? ORDER BY revision DESC LIMIT 1").get(ventureId) as
      | { record_json: string }
      | undefined;
    return row ? GoalRevisionSchema.parse(parseJson(row.record_json)) : undefined;
  }

  listGoalRevisions(ventureId: string): GoalRevision[] {
    return (this.db.prepare("SELECT record_json FROM goal_revisions WHERE venture_id=? ORDER BY revision,id").all(ventureId) as Array<{
      record_json: string;
    }>).map((row) => GoalRevisionSchema.parse(parseJson(row.record_json)));
  }

  createGoalRevision(input: GoalRevision): { created: boolean; record: GoalRevision } {
    const record = GoalRevisionSchema.parse(input);
    return this.transaction(() => {
      const replay = this.replayImmutable(
        "goal_revisions",
        "goal revision",
        record.ventureId,
        record.idempotencyKey,
        record.canonicalHash,
        (value) => GoalRevisionSchema.parse(value)
      );
      if (replay) return replay;

      const expected = this.nextGoalRevision(record.ventureId);
      if (record.revision !== expected) throw new StorageRevisionConflictError("goal revision", record.ventureId, expected, record.revision);
      const latest = this.getLatestGoalRevision(record.ventureId);
      if ((latest?.id ?? undefined) !== record.supersedesGoalRevisionId) {
        throw new Error(`goal supersession conflict: expected ${latest?.id ?? "none"}, received ${record.supersedesGoalRevisionId ?? "none"}`);
      }

      this.db
        .prepare(
          "INSERT INTO goal_revisions(venture_id,id,revision,canonical_hash,record_json,supersedes_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?)"
        )
        .run(
          record.ventureId,
          record.id,
          record.revision,
          record.canonicalHash,
          JSON.stringify(record),
          record.supersedesGoalRevisionId ?? null,
          record.idempotencyKey,
          record.createdAt
        );
      if (record.founderConfirmation.receiptId) {
        this.db
          .prepare(
            "INSERT INTO goal_revision_receipts(venture_id,goal_revision_id,receipt_id,binding_kind) VALUES(?,?,?,'founder-confirmation')"
          )
          .run(record.ventureId, record.id, record.founderConfirmation.receiptId);
      }
      return { created: true, record };
    });
  }

  getDecisionTrace(ventureId: string, decisionTraceId: string): DecisionTrace | undefined {
    const row = this.db.prepare("SELECT record_json FROM decision_traces WHERE venture_id=? AND id=?").get(ventureId, decisionTraceId) as
      | { record_json: string }
      | undefined;
    return row ? DecisionTraceSchema.parse(parseJson(row.record_json)) : undefined;
  }

  listDecisionTraces(ventureId: string, limit = 200): DecisionTrace[] {
    return (this.db
      .prepare("SELECT record_json FROM decision_traces WHERE venture_id=? ORDER BY created_at DESC,id DESC LIMIT ?")
      .all(ventureId, limit) as Array<{ record_json: string }>).map((row) => DecisionTraceSchema.parse(parseJson(row.record_json)));
  }

  createDecisionTrace(input: DecisionTrace): { created: boolean; record: DecisionTrace } {
    const record = DecisionTraceSchema.parse(input);
    return this.transaction(() => {
      const replay = this.replayImmutable(
        "decision_traces",
        "decision trace",
        record.ventureId,
        record.idempotencyKey,
        record.canonicalHash,
        (value) => DecisionTraceSchema.parse(value)
      );
      if (replay) return replay;

      if (record.evaluationContractId) {
        const evaluation = this.db
          .prepare("SELECT goal_revision_id,pack_revision_id FROM evaluation_contracts WHERE venture_id=? AND id=?")
          .get(record.ventureId, record.evaluationContractId) as { goal_revision_id: string; pack_revision_id: string } | undefined;
        if (!evaluation) {
          throw new Error(`evaluation contract not found or belongs to another venture: ${record.evaluationContractId}`);
        }
        if (evaluation.goal_revision_id !== record.goalRevisionId || evaluation.pack_revision_id !== record.packRevisionId) {
          throw new Error("decision trace does not match its evaluation contract goal and pack revisions");
        }
      }

      this.db
        .prepare(
          `INSERT INTO decision_traces(venture_id,id,goal_revision_id,evaluation_contract_id,pack_revision_id,canonical_hash,record_json,idempotency_key,created_at)
           VALUES(?,?,?,?,?,?,?,?,?)`
        )
        .run(
          record.ventureId,
          record.id,
          record.goalRevisionId ?? null,
          record.evaluationContractId ?? null,
          record.packRevisionId,
          record.canonicalHash,
          JSON.stringify(record),
          record.idempotencyKey,
          record.createdAt
        );
      const receiptStatement = this.db.prepare(
        "INSERT INTO decision_trace_receipts(venture_id,decision_trace_id,receipt_id,binding_kind) VALUES(?,?,?,'baseline')"
      );
      for (const receiptId of new Set(record.baseline.receiptIds)) receiptStatement.run(record.ventureId, record.id, receiptId);
      return { created: true, record };
    });
  }

  nextEvaluationRevision(ventureId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM evaluation_contracts WHERE venture_id=?")
      .get(ventureId) as { next: number };
    return row.next;
  }

  getEvaluationContract(ventureId: string, evaluationContractId: string): EvaluationContract | undefined {
    const row = this.db.prepare("SELECT record_json FROM evaluation_contracts WHERE venture_id=? AND id=?").get(ventureId, evaluationContractId) as
      | { record_json: string }
      | undefined;
    return row ? EvaluationContractSchema.parse(parseJson(row.record_json)) : undefined;
  }

  listEvaluationContracts(ventureId: string): EvaluationContract[] {
    return (this.db.prepare("SELECT record_json FROM evaluation_contracts WHERE venture_id=? ORDER BY revision,id").all(ventureId) as Array<{
      record_json: string;
    }>).map((row) => EvaluationContractSchema.parse(parseJson(row.record_json)));
  }

  createEvaluationContract(input: EvaluationContract): { created: boolean; record: EvaluationContract } {
    const record = EvaluationContractSchema.parse(input);
    return this.transaction(() => {
      const replay = this.replayImmutable(
        "evaluation_contracts",
        "evaluation contract",
        record.ventureId,
        record.idempotencyKey,
        record.canonicalHash,
        (value) => EvaluationContractSchema.parse(value)
      );
      if (replay) return replay;

      const expected = this.nextEvaluationRevision(record.ventureId);
      if (record.revision !== expected) {
        throw new StorageRevisionConflictError("evaluation contract", record.ventureId, expected, record.revision);
      }
      const latest = this.listEvaluationContracts(record.ventureId).at(-1);
      if ((latest?.id ?? undefined) !== record.supersedesEvaluationContractId) {
        throw new Error(
          `evaluation supersession conflict: expected ${latest?.id ?? "none"}, received ${record.supersedesEvaluationContractId ?? "none"}`
        );
      }

      this.db
        .prepare(
          `INSERT INTO evaluation_contracts(venture_id,id,revision,goal_revision_id,pack_revision_id,skill_version_id,canonical_hash,
             record_json,supersedes_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          record.ventureId,
          record.id,
          record.revision,
          record.goalRevisionId,
          record.packRevisionId,
          record.skillVersionId ?? null,
          record.canonicalHash,
          JSON.stringify(record),
          record.supersedesEvaluationContractId ?? null,
          record.idempotencyKey,
          record.createdAt
        );

      const receiptStatement = this.db.prepare(
        "INSERT INTO evaluation_baseline_receipts(venture_id,evaluation_contract_id,receipt_id,binding_kind) VALUES(?,?,?,?)"
      );
      for (const receiptId of new Set(record.baseline.receiptIds)) receiptStatement.run(record.ventureId, record.id, receiptId, "baseline");
      for (const receiptId of new Set(record.baseline.plainAgentReceiptIds)) {
        receiptStatement.run(record.ventureId, record.id, receiptId, "plain-agent");
      }
      for (const receiptId of new Set(record.baseline.noHistoryReceiptIds)) {
        receiptStatement.run(record.ventureId, record.id, receiptId, "no-history");
      }
      return { created: true, record };
    });
  }

  nextExperimentSequence(ventureId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM experiment_records WHERE venture_id=?")
      .get(ventureId) as { next: number };
    return row.next;
  }

  getExperimentRecord(ventureId: string, experimentRecordId: string): ExperimentRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM experiment_records WHERE venture_id=? AND id=?").get(ventureId, experimentRecordId) as
      | { record_json: string }
      | undefined;
    return row ? ExperimentRecordSchema.parse(parseJson(row.record_json)) : undefined;
  }

  listExperimentRecords(ventureId: string, evaluationContractId?: string): ExperimentRecord[] {
    const rows = evaluationContractId
      ? this.db
          .prepare("SELECT record_json FROM experiment_records WHERE venture_id=? AND evaluation_contract_id=? ORDER BY sequence,id")
          .all(ventureId, evaluationContractId)
      : this.db.prepare("SELECT record_json FROM experiment_records WHERE venture_id=? ORDER BY sequence,id").all(ventureId);
    return (rows as Array<{ record_json: string }>).map((row) => ExperimentRecordSchema.parse(parseJson(row.record_json)));
  }

  createExperimentRecord(input: ExperimentRecord, terminalReceipt?: Receipt): { created: boolean; record: ExperimentRecord } {
    const record = ExperimentRecordSchema.parse(input);
    const terminal = terminalReceipt ? ReceiptSchema.parse(terminalReceipt) : undefined;
    if (terminal && (terminal.ventureId !== record.ventureId || terminal.id !== record.terminalReceiptId)) {
      throw new Error("engine terminal receipt must match the experiment venture and terminal receipt id");
    }
    return this.transaction(() => {
      const replay = this.replayImmutable(
        "experiment_records",
        "experiment record",
        record.ventureId,
        record.idempotencyKey,
        record.canonicalHash,
        (value) => ExperimentRecordSchema.parse(value)
      );
      if (replay) return replay;

      if (terminal) {
        const prior = this.db
          .prepare("SELECT id,content_hash FROM receipts WHERE venture_id=? AND (id=? OR content_hash=?)")
          .get(terminal.ventureId, terminal.id, terminal.contentHash) as { id: string; content_hash: string } | undefined;
        if (prior && (prior.id !== terminal.id || prior.content_hash !== terminal.contentHash)) {
          throw new StorageIdempotencyConflictError("engine terminal receipt", terminal.ventureId, terminal.id);
        }
        if (!prior) {
          this.db
            .prepare(
              "INSERT INTO receipts(venture_id,id,task_id,dispatch_id,proof_tier,outcome,actor,adapter,artifact_path,content_hash,occurred_at,metadata_json,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
            )
            .run(
              terminal.ventureId,
              terminal.id,
              terminal.taskId ?? null,
              terminal.dispatchId ?? null,
              terminal.proofTier,
              terminal.outcome,
              terminal.actor,
              terminal.adapter,
              terminal.artifactPath,
              terminal.contentHash,
              terminal.occurredAt,
              JSON.stringify(terminal.metadata),
              terminal.origin
            );
        }
      }

      const expected = this.nextExperimentSequence(record.ventureId);
      if (record.sequence !== expected) {
        throw new StorageRevisionConflictError("experiment sequence", record.ventureId, expected, record.sequence);
      }
      const evaluation = this.db
        .prepare("SELECT canonical_hash,goal_revision_id FROM evaluation_contracts WHERE venture_id=? AND id=?")
        .get(record.ventureId, record.evaluationContractId) as { canonical_hash: string; goal_revision_id: string } | undefined;
      if (!evaluation) throw new Error(`evaluation contract not found or belongs to another venture: ${record.evaluationContractId}`);
      if (evaluation.canonical_hash !== record.evaluationContractHash) throw new Error("evaluation contract hash mismatch");
      if (evaluation.goal_revision_id !== record.goalRevisionId) throw new Error("experiment goal revision does not match its evaluation contract");

      this.db
        .prepare(
          `INSERT INTO experiment_records(venture_id,id,sequence,evaluation_contract_id,goal_revision_id,skill_version_id,canonical_hash,
             disposition,record_json,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          record.ventureId,
          record.id,
          record.sequence,
          record.evaluationContractId,
          record.goalRevisionId,
          record.skillVersionId ?? null,
          record.canonicalHash,
          record.disposition,
          JSON.stringify(record),
          record.idempotencyKey,
          record.createdAt
        );

      const receiptStatement = this.db.prepare(
        "INSERT OR IGNORE INTO experiment_receipts(venture_id,experiment_record_id,receipt_id,binding_kind) VALUES(?,?,?,?)"
      );
      receiptStatement.run(record.ventureId, record.id, record.baselineReceiptId, "baseline");
      for (const receiptId of new Set(record.receiptIds)) receiptStatement.run(record.ventureId, record.id, receiptId, "record");
      if (record.outcomeReceiptId) receiptStatement.run(record.ventureId, record.id, record.outcomeReceiptId, "outcome");
      receiptStatement.run(record.ventureId, record.id, record.terminalReceiptId, "terminal");
      if (record.reviewer) receiptStatement.run(record.ventureId, record.id, record.reviewer.receiptId, "reviewer");
      if (record.primaryMetricResult) {
        receiptStatement.run(record.ventureId, record.id, record.primaryMetricResult.scoringReceiptId, "scoring");
      }
      for (const attempt of record.attempts) {
        for (const receiptId of new Set(attempt.receiptIds)) {
          receiptStatement.run(record.ventureId, record.id, receiptId, `attempt:${attempt.attempt}`);
        }
      }
      return { created: true, record };
    });
  }

  nextSkillRevision(ventureId: string, skillId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM skill_versions WHERE venture_id=? AND skill_id=?")
      .get(ventureId, skillId) as { next: number };
    return row.next;
  }

  getSkillVersion(ventureId: string, skillVersionId: string): SkillVersion | undefined {
    const row = this.db.prepare("SELECT record_json FROM skill_versions WHERE venture_id=? AND id=?").get(ventureId, skillVersionId) as
      | { record_json: string }
      | undefined;
    return row ? SkillVersionSchema.parse(parseJson(row.record_json)) : undefined;
  }

  listSkillVersions(ventureId: string, options: SkillVersionPageOptions): StorageCursorPage<SkillVersion>;
  listSkillVersions(ventureId: string, options?: SkillVersionListOptions): SkillVersion[];
  listSkillVersions(
    ventureId: string,
    options: SkillVersionListOptions & { includePageInfo?: boolean } = {}
  ): SkillVersion[] | StorageCursorPage<SkillVersion> {
    const filters: CursorListFilter[] = [];
    if (options.skillId) filters.push({ clause: "skill_id=?", value: options.skillId });
    if (options.state) filters.push({ clause: "evidence_state=?", value: options.state });
    const page = this.listImmutableCursorPage(
      "skill_versions",
      "skill version",
      ventureId,
      filters,
      options,
      (value) => SkillVersionSchema.parse(value)
    );
    return options.includePageInfo ? page : page.records;
  }

  createSkillVersion(input: SkillVersion): { created: boolean; record: SkillVersion } {
    const record = SkillVersionSchema.parse(input);
    return this.transaction(() => {
      this.requireSameWorkspace(record.ventureId, record.evaluatedVentureIds);
      const replay = this.replayImmutable(
        "skill_versions",
        "skill version",
        record.ventureId,
        record.idempotencyKey,
        record.canonicalHash,
        (value) => SkillVersionSchema.parse(value)
      );
      if (replay) return replay;

      const expected = this.nextSkillRevision(record.ventureId, record.skillId);
      if (record.revision !== expected) throw new StorageRevisionConflictError("skill version", record.ventureId, expected, record.revision);
      const latestRow = this.db
        .prepare("SELECT record_json FROM skill_versions WHERE venture_id=? AND skill_id=? ORDER BY revision DESC LIMIT 1")
        .get(record.ventureId, record.skillId) as { record_json: string } | undefined;
      const latest = latestRow ? SkillVersionSchema.parse(parseJson(latestRow.record_json)) : undefined;
      if ((latest?.id ?? undefined) !== record.supersedesSkillVersionId) {
        throw new Error(
          `skill supersession conflict: expected ${latest?.id ?? "none"}, received ${record.supersedesSkillVersionId ?? "none"}`
        );
      }

      this.db
        .prepare(
          `INSERT INTO skill_versions(venture_id,id,skill_id,skill_name,semantic_version,revision,evidence_state,canonical_hash,record_json,
             supersedes_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          record.ventureId,
          record.id,
          record.skillId,
          record.name,
          record.version,
          record.revision,
          record.state,
          record.canonicalHash,
          JSON.stringify(record),
          record.supersedesSkillVersionId ?? null,
          record.idempotencyKey,
          record.createdAt
        );

      const allowedVentures = [record.ventureId, ...record.evaluatedVentureIds];
      const evaluationStatement = this.db.prepare(
        `INSERT INTO skill_version_evaluations(skill_venture_id,skill_version_id,evaluation_venture_id,evaluation_contract_id)
         VALUES(?,?,?,?)`
      );
      for (const evaluationId of new Set(record.evaluationContractIds)) {
        const referenceVenture = this.resolveReferenceVenture("evaluation_contracts", evaluationId, allowedVentures, "evaluation contract");
        evaluationStatement.run(record.ventureId, record.id, referenceVenture, evaluationId);
      }
      const experimentStatement = this.db.prepare(
        `INSERT INTO skill_version_experiments(skill_venture_id,skill_version_id,experiment_venture_id,experiment_record_id)
         VALUES(?,?,?,?)`
      );
      for (const experimentId of new Set(record.experimentRecordIds)) {
        const referenceVenture = this.resolveReferenceVenture("experiment_records", experimentId, allowedVentures, "experiment record");
        experimentStatement.run(record.ventureId, record.id, referenceVenture, experimentId);
      }
      const evidenceStatement = this.db.prepare(
        "INSERT INTO skill_version_evidence(skill_venture_id,skill_version_id,evidence_venture_id,evidence_id) VALUES(?,?,?,?)"
      );
      for (const evidenceId of new Set(record.evidenceIds)) {
        const referenceVenture = this.resolveReferenceVenture("evidence", evidenceId, allowedVentures, "evidence");
        evidenceStatement.run(record.ventureId, record.id, referenceVenture, evidenceId);
      }
      return { created: true, record };
    });
  }

  nextPromotionRevision(ventureId: string, playId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM play_promotions WHERE venture_id=? AND play_id=?")
      .get(ventureId, playId) as { next: number };
    return row.next;
  }

  getPlayPromotion(ventureId: string, playPromotionId: string): PlayPromotion | undefined {
    const row = this.db.prepare("SELECT record_json FROM play_promotions WHERE venture_id=? AND id=?").get(ventureId, playPromotionId) as
      | { record_json: string }
      | undefined;
    return row ? PlayPromotionSchema.parse(parseJson(row.record_json)) : undefined;
  }

  listPlayPromotions(ventureId: string, options: PlayPromotionPageOptions): StorageCursorPage<PlayPromotion>;
  listPlayPromotions(ventureId: string, options?: PlayPromotionListOptions): PlayPromotion[];
  listPlayPromotions(
    ventureId: string,
    options: PlayPromotionListOptions & { includePageInfo?: boolean } = {}
  ): PlayPromotion[] | StorageCursorPage<PlayPromotion> {
    const filters: CursorListFilter[] = [];
    if (options.playId) filters.push({ clause: "play_id=?", value: options.playId });
    if (options.skillVersionId) filters.push({ clause: "skill_version_id=?", value: options.skillVersionId });
    if (options.state) filters.push({ clause: "target_state=?", value: options.state });
    const page = this.listImmutableCursorPage(
      "play_promotions",
      "play promotion",
      ventureId,
      filters,
      options,
      (value) => PlayPromotionSchema.parse(value)
    );
    return options.includePageInfo ? page : page.records;
  }

  createPlayPromotion(input: PlayPromotion): { created: boolean; record: PlayPromotion } {
    const record = PlayPromotionSchema.parse(input);
    return this.transaction(() => {
      this.requireSameWorkspace(record.ventureId, record.transferVentureIds);
      const replay = this.replayImmutable(
        "play_promotions",
        "play promotion",
        record.ventureId,
        record.idempotencyKey,
        record.canonicalHash,
        (value) => PlayPromotionSchema.parse(value)
      );
      if (replay) return replay;

      const expected = this.nextPromotionRevision(record.ventureId, record.playId);
      if (record.revision !== expected) throw new StorageRevisionConflictError("play promotion", record.ventureId, expected, record.revision);
      const latestRow = this.db
        .prepare("SELECT record_json FROM play_promotions WHERE venture_id=? AND play_id=? ORDER BY revision DESC LIMIT 1")
        .get(record.ventureId, record.playId) as { record_json: string } | undefined;
      const latest = latestRow ? PlayPromotionSchema.parse(parseJson(latestRow.record_json)) : undefined;
      if ((latest?.id ?? undefined) !== record.supersedesPlayPromotionId) {
        throw new Error(
          `promotion supersession conflict: expected ${latest?.id ?? "none"}, received ${record.supersedesPlayPromotionId ?? "none"}`
        );
      }
      const skill = this.getSkillVersion(record.ventureId, record.skillVersionId);
      if (!skill) throw new Error(`skill version not found or belongs to another venture: ${record.skillVersionId}`);
      if (skill.state !== record.fromState) {
        throw new Error(`promotion source state ${record.fromState} does not match skill state ${skill.state}`);
      }

      this.db
        .prepare(
          `INSERT INTO play_promotions(venture_id,id,play_id,skill_version_id,revision,decision,target_state,canonical_hash,record_json,
             supersedes_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          record.ventureId,
          record.id,
          record.playId,
          record.skillVersionId,
          record.revision,
          record.decision,
          record.toState,
          record.canonicalHash,
          JSON.stringify(record),
          record.supersedesPlayPromotionId ?? null,
          record.idempotencyKey,
          record.createdAt
        );

      const allowedVentures = [record.ventureId, ...record.transferVentureIds];
      const experimentStatement = this.db.prepare(
        `INSERT INTO play_promotion_experiments(promotion_venture_id,play_promotion_id,experiment_venture_id,experiment_record_id)
         VALUES(?,?,?,?)`
      );
      for (const experimentId of new Set(record.experimentRecordIds)) {
        const referenceVenture = this.resolveReferenceVenture("experiment_records", experimentId, allowedVentures, "experiment record");
        experimentStatement.run(record.ventureId, record.id, referenceVenture, experimentId);
      }
      const evaluationStatement = this.db.prepare(
        `INSERT INTO play_promotion_evaluations(promotion_venture_id,play_promotion_id,evaluation_venture_id,evaluation_contract_id)
         VALUES(?,?,?,?)`
      );
      for (const evaluationId of new Set(record.evaluationContractIds)) {
        const referenceVenture = this.resolveReferenceVenture("evaluation_contracts", evaluationId, allowedVentures, "evaluation contract");
        evaluationStatement.run(record.ventureId, record.id, referenceVenture, evaluationId);
      }
      const evidenceStatement = this.db.prepare(
        "INSERT INTO play_promotion_evidence(promotion_venture_id,play_promotion_id,evidence_venture_id,evidence_id) VALUES(?,?,?,?)"
      );
      for (const evidenceId of new Set(record.evidenceIds)) {
        const referenceVenture = this.resolveReferenceVenture("evidence", evidenceId, allowedVentures, "evidence");
        evidenceStatement.run(record.ventureId, record.id, referenceVenture, evidenceId);
      }
      const receiptStatement = this.db.prepare(
        `INSERT INTO play_promotion_receipts(promotion_venture_id,play_promotion_id,receipt_venture_id,receipt_id,binding_kind)
         VALUES(?,?,?,?,?)`
      );
      for (const receiptId of new Set(record.noHistoryBaselineReceiptIds)) {
        const referenceVenture = this.resolveReferenceVenture("receipts", receiptId, allowedVentures, "no-history baseline receipt");
        receiptStatement.run(record.ventureId, record.id, referenceVenture, receiptId, "no-history");
      }
      for (const receiptId of new Set(record.plainAgentBaselineReceiptIds)) {
        const referenceVenture = this.resolveReferenceVenture("receipts", receiptId, allowedVentures, "plain-agent baseline receipt");
        receiptStatement.run(record.ventureId, record.id, referenceVenture, receiptId, "plain-agent");
      }
      return { created: true, record };
    });
  }

  upsertPlay(ventureId: string, play: Record<string, unknown> & { id: string; reusable: boolean }): { created: boolean; version: number } {
    return this.transaction(() => {
      const latest = this.db
        .prepare("SELECT version,definition_json FROM plays WHERE venture_id=? AND id=? ORDER BY version DESC LIMIT 1")
        .get(ventureId, play.id) as { version: number; definition_json: string } | undefined;
      if (latest && sha256(parseJson(latest.definition_json)) === sha256(play)) return { created: false, version: latest.version };
      const version = (latest?.version ?? 0) + 1;
      this.db
        .prepare("INSERT INTO plays(venture_id,id,version,definition_json,reusable,created_at) VALUES(?,?,?,?,?,?)")
        .run(ventureId, play.id, version, JSON.stringify(play), play.reusable ? 1 : 0, nowIso());
      return { created: true, version };
    });
  }

  listPlays(ventureId: string): any[] {
    return (this.db.prepare("SELECT * FROM plays WHERE venture_id=? ORDER BY id,version DESC").all(ventureId) as any[]).map((row) => ({
      ...parseJson(row.definition_json),
      version: row.version
    }));
  }

  createTask(task: TaskDefinition, actionDigest: string, status: TaskStatus = "planned"): { created: boolean; task: TaskDefinition } {
    TaskDefinitionSchema.parse(task);
    const prior = this.db
      .prepare("SELECT definition_json FROM tasks WHERE venture_id=? AND idempotency_key=?")
      .get(task.ventureId, task.idempotencyKey) as { definition_json: string } | undefined;
    if (prior) return { created: false, task: TaskDefinitionSchema.parse(parseJson(prior.definition_json)) };
    this.transaction(() => {
      const at = nowIso();
      this.db
        .prepare(
          `INSERT INTO tasks(venture_id,id,play_id,purpose,owner_role,mode,gate_class,status,expected_proof,definition_json,action_digest,idempotency_key,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          task.ventureId,
          task.id,
          task.playId ?? null,
          task.purpose,
          task.ownerRole,
          task.mode,
          task.gateClass,
          status,
          task.expectedProof,
          JSON.stringify(task),
          actionDigest,
          task.idempotencyKey,
          at,
          at
        );
      const dependencyStatement = this.db.prepare(
        "INSERT INTO task_dependencies(venture_id,task_id,depends_on_task_id) VALUES(?,?,?)"
      );
      for (const dependency of task.dependencies) dependencyStatement.run(task.ventureId, task.id, dependency);
    });
    return { created: true, task };
  }

  createTaskGraph(
    entries: ReadonlyArray<{ task: TaskDefinition; actionDigest: string; status: TaskStatus }>
  ): { created: boolean; tasks: TaskDefinition[] } {
    if (entries.length === 0) throw new Error("task graph requires at least one task");
    const normalized = entries.map((entry) => ({ ...entry, task: TaskDefinitionSchema.parse(entry.task) }));
    const ventureId = normalized[0]!.task.ventureId;
    if (normalized.some((entry) => entry.task.ventureId !== ventureId)) {
      throw new Error("task graph cannot cross venture boundaries");
    }
    if (new Set(normalized.map((entry) => entry.task.id)).size !== normalized.length) {
      throw new Error("task graph task ids must be unique");
    }
    if (new Set(normalized.map((entry) => entry.task.idempotencyKey)).size !== normalized.length) {
      throw new Error("task graph idempotency keys must be unique");
    }

    const priorRows = normalized.map((entry) =>
      this.db
        .prepare("SELECT id,definition_json,action_digest FROM tasks WHERE venture_id=? AND idempotency_key=?")
        .get(ventureId, entry.task.idempotencyKey) as
        | { id: string; definition_json: string; action_digest: string }
        | undefined
    );
    const priorCount = priorRows.filter(Boolean).length;
    if (priorCount > 0 && priorCount !== normalized.length) {
      throw new StorageIdempotencyConflictError("task graph", ventureId, normalized[0]!.task.idempotencyKey);
    }
    if (priorCount === normalized.length) {
      for (const [index, prior] of priorRows.entries()) {
        const entry = normalized[index]!;
        const stored = TaskDefinitionSchema.parse(parseJson(prior!.definition_json));
        if (prior!.id !== entry.task.id || prior!.action_digest !== entry.actionDigest || sha256(stored) !== sha256(entry.task)) {
          throw new StorageIdempotencyConflictError("task graph", ventureId, entry.task.idempotencyKey);
        }
      }
      return { created: false, tasks: normalized.map((entry) => entry.task) };
    }

    return this.transaction(() => {
      const insertTask = this.db.prepare(
        `INSERT INTO tasks(venture_id,id,play_id,purpose,owner_role,mode,gate_class,status,expected_proof,definition_json,action_digest,idempotency_key,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      const insertDependency = this.db.prepare(
        "INSERT INTO task_dependencies(venture_id,task_id,depends_on_task_id) VALUES(?,?,?)"
      );
      const at = nowIso();
      for (const entry of normalized) {
        const task = entry.task;
        insertTask.run(
          task.ventureId,
          task.id,
          task.playId ?? null,
          task.purpose,
          task.ownerRole,
          task.mode,
          task.gateClass,
          entry.status,
          task.expectedProof,
          JSON.stringify(task),
          entry.actionDigest,
          task.idempotencyKey,
          at,
          at
        );
        for (const dependency of task.dependencies) insertDependency.run(task.ventureId, task.id, dependency);
      }
      return { created: true, tasks: normalized.map((entry) => entry.task) };
    });
  }

  getTask(ventureId: string, taskId: string): (TaskDefinition & { status: TaskStatus; actionDigest: string; attemptCount: number }) | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE venture_id=? AND id=?").get(ventureId, taskId) as TaskRow | undefined;
    if (!row) return undefined;
    return { ...TaskDefinitionSchema.parse(parseJson(row.definition_json)), status: row.status, actionDigest: row.action_digest, attemptCount: row.attempt_count };
  }

  listTasks(ventureId: string): Array<TaskDefinition & { status: TaskStatus; actionDigest: string; attemptCount: number }> {
    return (this.db.prepare("SELECT * FROM tasks WHERE venture_id=? ORDER BY created_at,id").all(ventureId) as unknown as TaskRow[]).map((row) => ({
      ...TaskDefinitionSchema.parse(parseJson(row.definition_json)),
      status: row.status,
      actionDigest: row.action_digest,
      attemptCount: row.attempt_count
    }));
  }

  setTaskStatus(ventureId: string, taskId: string, status: TaskStatus, details?: string): void {
    const result = this.db
      .prepare("UPDATE tasks SET status=?,dead_letter_reason=COALESCE(?,dead_letter_reason),updated_at=? WHERE venture_id=? AND id=?")
      .run(status, details ?? null, nowIso(), ventureId, taskId);
    if (Number(result.changes) !== 1) throw new Error(`task not found for venture: ${ventureId}/${taskId}`);
  }

  enqueueJob(input: { ventureId: string; id: string; taskId: string; kind: string; payload: unknown; availableAt?: string }): { created: boolean; id: string } {
    const prior = this.db
      .prepare("SELECT id FROM jobs WHERE venture_id=? AND task_id=? AND kind=?")
      .get(input.ventureId, input.taskId, input.kind) as { id: string } | undefined;
    if (prior) return { created: false, id: prior.id };
    const at = nowIso();
    this.db
      .prepare(
        "INSERT INTO jobs(venture_id,id,task_id,kind,status,payload_json,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)"
      )
      .run(input.ventureId, input.id, input.taskId, input.kind, "queued", JSON.stringify(input.payload), input.availableAt ?? at, at, at);
    this.setTaskStatus(input.ventureId, input.taskId, "queued");
    return { created: true, id: input.id };
  }

  recoverExpiredJobs(workspaceId: string, at = nowIso()): number {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status='queued',lease_owner=NULL,lease_expires_at=NULL,updated_at=?
         WHERE venture_id IN (SELECT id FROM ventures WHERE workspace_id=?) AND status='leased' AND lease_expires_at < ?`
      )
      .run(at, workspaceId, at);
    return Number(result.changes);
  }

  claimNextJob(workspaceId: string, workerId: string, leaseMs: number): (JobRow & { payload: unknown }) | undefined {
    return this.transaction(() => {
      const now = new Date();
      const row = this.db
        .prepare(
          `SELECT j.* FROM jobs j
           JOIN ventures v ON v.id=j.venture_id
           JOIN tasks t ON t.venture_id=j.venture_id AND t.id=j.task_id
           WHERE v.workspace_id=? AND j.kind='role-dispatch' AND j.status='queued' AND j.available_at<=?
             AND t.status NOT IN ('cancelled','dead-letter','succeeded')
             AND NOT EXISTS (
               SELECT 1 FROM task_dependencies td
               JOIN tasks dependency ON dependency.venture_id=td.venture_id AND dependency.id=td.depends_on_task_id
               WHERE td.venture_id=j.venture_id AND td.task_id=j.task_id AND dependency.status<>'succeeded'
             )
           ORDER BY j.available_at,j.created_at LIMIT 1`
        )
        .get(workspaceId, now.toISOString()) as JobRow | undefined;
      if (!row) return undefined;
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const updated = this.db
        .prepare(
          "UPDATE jobs SET status='leased',lease_owner=?,lease_expires_at=?,attempt_count=attempt_count+1,updated_at=? WHERE venture_id=? AND id=? AND status='queued'"
        )
        .run(workerId, leaseExpiresAt, now.toISOString(), row.venture_id, row.id);
      if (Number(updated.changes) !== 1) return undefined;
      this.db
        .prepare("UPDATE tasks SET status='running',attempt_count=attempt_count+1,updated_at=? WHERE venture_id=? AND id=?")
        .run(now.toISOString(), row.venture_id, row.task_id);
      return { ...row, status: "leased", lease_owner: workerId, lease_expires_at: leaseExpiresAt, attempt_count: row.attempt_count + 1, payload: parseJson(row.payload_json) };
    });
  }

  completeJob(ventureId: string, jobId: string, taskId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE jobs SET status='succeeded',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE venture_id=? AND id=?").run(nowIso(), ventureId, jobId);
      this.setTaskStatus(ventureId, taskId, "succeeded");
    });
  }

  failJob(input: { ventureId: string; jobId: string; taskId: string; error: string; retryAt?: string; deadLetter: boolean }): void {
    this.transaction(() => {
      const status = input.deadLetter ? "dead-letter" : "queued";
      this.db
        .prepare("UPDATE jobs SET status=?,available_at=COALESCE(?,available_at),lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE venture_id=? AND id=?")
        .run(status, input.retryAt ?? null, input.error.slice(0, 4000), nowIso(), input.ventureId, input.jobId);
      this.setTaskStatus(input.ventureId, input.taskId, input.deadLetter ? "dead-letter" : "queued", input.deadLetter ? input.error : undefined);
    });
  }

  haltJobForGoalChange(input: {
    ventureId: string;
    jobId: string;
    taskId: string;
    disposition: Exclude<GoalTaskDisposition, "keep">;
    reason: string;
  }): void {
    this.transaction(() => {
      const at = nowIso();
      this.db
        .prepare(
          "UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE venture_id=? AND id=? AND status IN ('queued','leased')"
        )
        .run(input.reason.slice(0, 4000), at, input.ventureId, input.jobId);
      if (input.disposition === "cancel") {
        this.db
          .prepare(
            "UPDATE tasks SET status='cancelled',cancelled_at=?,dead_letter_reason=?,updated_at=? WHERE venture_id=? AND id=? AND status NOT IN ('succeeded','cancelled','dead-letter')"
          )
          .run(at, input.reason.slice(0, 4000), at, input.ventureId, input.taskId);
      } else {
        this.db
          .prepare(
            "UPDATE tasks SET status='blocked',dead_letter_reason=?,updated_at=? WHERE venture_id=? AND id=? AND status NOT IN ('succeeded','cancelled','dead-letter')"
          )
          .run(input.reason.slice(0, 4000), at, input.ventureId, input.taskId);
      }
    });
  }

  listJobs(ventureId: string): any[] {
    return (this.db.prepare("SELECT * FROM jobs WHERE venture_id=? ORDER BY created_at").all(ventureId) as any[]).map((row) => ({ ...row, payload: parseJson(row.payload_json) }));
  }

  cancelTask(ventureId: string, taskId: string, at = nowIso()): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE tasks SET status='cancelled',cancelled_at=?,updated_at=? WHERE venture_id=? AND id=? AND status NOT IN ('succeeded','cancelled','dead-letter')")
        .run(at, at, ventureId, taskId);
      if (Number(result.changes) === 0) return false;
      this.db
        .prepare("UPDATE jobs SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE venture_id=? AND task_id=? AND status IN ('queued','leased')")
        .run(at, ventureId, taskId);
      return true;
    });
  }

  createDispatch(input: { ventureId: string; id: string; taskId: string; adapter: string; ownerRole: string }): { created: boolean; id: string } {
    const prior = this.db
      .prepare("SELECT id FROM dispatches WHERE venture_id=? AND task_id=? AND adapter=?")
      .get(input.ventureId, input.taskId, input.adapter) as { id: string } | undefined;
    if (prior) return { created: false, id: prior.id };
    this.db
      .prepare("INSERT INTO dispatches(venture_id,id,task_id,adapter,owner_role,status,created_at) VALUES(?,?,?,?,?,'created',?)")
      .run(input.ventureId, input.id, input.taskId, input.adapter, input.ownerRole, nowIso());
    return { created: true, id: input.id };
  }

  updateDispatch(input: { ventureId: string; id: string; status: string; externalTaskId?: string; externalRunId?: string; result?: unknown; startedAt?: string; completedAt?: string }): void {
    const result = this.db
      .prepare(
        `UPDATE dispatches SET status=?,external_task_id=COALESCE(?,external_task_id),external_run_id=COALESCE(?,external_run_id),
         result_json=COALESCE(?,result_json),started_at=COALESCE(?,started_at),completed_at=COALESCE(?,completed_at) WHERE venture_id=? AND id=?`
      )
      .run(
        input.status,
        input.externalTaskId ?? null,
        input.externalRunId ?? null,
        input.result === undefined ? null : JSON.stringify(input.result),
        input.startedAt ?? null,
        input.completedAt ?? null,
        input.ventureId,
        input.id
      );
    if (Number(result.changes) !== 1) throw new Error(`dispatch not found: ${input.ventureId}/${input.id}`);
  }

  listDispatches(ventureId: string): any[] {
    return (this.db.prepare("SELECT * FROM dispatches WHERE venture_id=? ORDER BY created_at").all(ventureId) as any[]).map((row) => ({
      ...row,
      ...(row.result_json ? { result: parseJson(row.result_json) } : {})
    }));
  }

  attachReceipt(input: Receipt | ReceiptAttachInput): { created: boolean; id: string } {
    const receipt = ReceiptSchema.parse(input);
    const prior = this.db.prepare("SELECT id FROM receipts WHERE venture_id=? AND content_hash=?").get(receipt.ventureId, receipt.contentHash) as
      | { id: string }
      | undefined;
    if (prior) return { created: false, id: prior.id };
    this.db
      .prepare(
        "INSERT INTO receipts(venture_id,id,task_id,dispatch_id,proof_tier,outcome,actor,adapter,artifact_path,content_hash,occurred_at,metadata_json,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        receipt.ventureId,
        receipt.id,
        receipt.taskId ?? null,
        receipt.dispatchId ?? null,
        receipt.proofTier,
        receipt.outcome,
        receipt.actor,
        receipt.adapter,
        receipt.artifactPath,
        receipt.contentHash,
        receipt.occurredAt,
        JSON.stringify(receipt.metadata),
        receipt.origin
      );
    return { created: true, id: receipt.id };
  }

  listReceipts(ventureId: string): Receipt[] {
    return (this.db.prepare("SELECT * FROM receipts WHERE venture_id=? ORDER BY occurred_at,id").all(ventureId) as any[]).map((row) =>
      ReceiptSchema.parse({
        id: row.id,
        ventureId: row.venture_id,
        ...(row.task_id ? { taskId: row.task_id } : {}),
        ...(row.dispatch_id ? { dispatchId: row.dispatch_id } : {}),
        proofTier: row.proof_tier,
        outcome: row.outcome,
        actor: row.actor,
        adapter: row.adapter,
        artifactPath: row.artifact_path,
        contentHash: row.content_hash,
        occurredAt: row.occurred_at,
        metadata: parseJson(row.metadata_json),
        origin: row.origin
      })
    );
  }

  listPendingApprovals(workspaceId: string, ventureId?: string): any[] {
    const statement: StatementSync = ventureId
      ? this.db.prepare(
          `SELECT a.* FROM approvals a JOIN ventures v ON v.id=a.venture_id
           WHERE v.workspace_id=? AND a.venture_id=? AND a.status='pending' ORDER BY a.created_at`
        )
      : this.db.prepare(
          `SELECT a.* FROM approvals a JOIN ventures v ON v.id=a.venture_id
           WHERE v.workspace_id=? AND a.status='pending' ORDER BY a.created_at`
        );
    const rows = ventureId ? statement.all(workspaceId, ventureId) : statement.all(workspaceId);
    return (rows as any[]).map((row) => ({ ...row, packet: parseJson(row.packet_json) }));
  }

  createApproval(input: { ventureId: string; id: string; taskId: string; actionDigest: string; packet: unknown; expiresAt: string }): void {
    this.db
      .prepare("INSERT INTO approvals(venture_id,id,task_id,action_digest,status,packet_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(input.ventureId, input.id, input.taskId, input.actionDigest, "pending", JSON.stringify(input.packet), input.expiresAt, nowIso());
  }

  getApproval(ventureId: string, approvalId: string): any | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE venture_id=? AND id=?").get(ventureId, approvalId) as any;
    return row ? { ...row, packet: parseJson(row.packet_json) } : undefined;
  }

  revokeApproval(ventureId: string, approvalId: string, at: string): boolean {
    const result = this.db
      .prepare("UPDATE approvals SET status='revoked',revoked_at=? WHERE venture_id=? AND id=? AND status IN ('pending','approved')")
      .run(at, ventureId, approvalId);
    return Number(result.changes) === 1;
  }

  setMetric(input: { ventureId: string; id: string; name: string; value?: number; unit: string; status: string; sourceRef?: string; observedAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO metrics(venture_id,id,name,value,unit,status,source_ref,observed_at) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(venture_id,id) DO UPDATE SET name=excluded.name,value=excluded.value,unit=excluded.unit,status=excluded.status,
           source_ref=excluded.source_ref,observed_at=excluded.observed_at`
      )
      .run(input.ventureId, input.id, input.name, input.value ?? null, input.unit, input.status, input.sourceRef ?? null, input.observedAt);
  }

  ensureMetricDefinition(input: { ventureId: string; id: string; name: string; unit: string; status: string; observedAt: string; sourceRef?: string }): void {
    this.db
      .prepare(
        `INSERT INTO metrics(venture_id,id,name,value,unit,status,source_ref,observed_at) VALUES(?,?,?,NULL,?,?,?,?)
         ON CONFLICT(venture_id,id) DO UPDATE SET name=excluded.name,unit=excluded.unit`
      )
      .run(input.ventureId, input.id, input.name, input.unit, input.status, input.sourceRef ?? null, input.observedAt);
  }

  listMetrics(ventureId: string): any[] {
    return this.db.prepare("SELECT * FROM metrics WHERE venture_id=? ORDER BY id").all(ventureId) as any[];
  }

  founderInterventionCount(ventureId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM founder_interventions WHERE venture_id=?").get(ventureId) as { count: number }).count;
  }

  recordFounderIntervention(input: {
    ventureId: string;
    id: string;
    taskId?: string;
    gateClass: string;
    reason: string;
    status?: string;
    createdAt?: string;
  }): { created: boolean; id: string } {
    const prior = this.db.prepare("SELECT id FROM founder_interventions WHERE venture_id=? AND id=?").get(input.ventureId, input.id) as
      | { id: string }
      | undefined;
    if (prior) return { created: false, id: prior.id };
    this.db
      .prepare(
        "INSERT INTO founder_interventions(venture_id,id,task_id,gate_class,reason,status,created_at) VALUES(?,?,?,?,?,?,?)"
      )
      .run(
        input.ventureId,
        input.id,
        input.taskId ?? null,
        input.gateClass,
        input.reason,
        input.status ?? "pending",
        input.createdAt ?? nowIso()
      );
    return { created: true, id: input.id };
  }

  isKilled(ventureId: string): boolean {
    const row = this.db.prepare("SELECT kill_switch FROM ventures WHERE id=?").get(ventureId) as { kill_switch: number } | undefined;
    if (!row) throw new Error(`venture not found: ${ventureId}`);
    return row.kill_switch === 1;
  }

  setKillSwitch(ventureId: string, killed: boolean): void {
    const result = this.db.prepare("UPDATE ventures SET kill_switch=?,updated_at=? WHERE id=?").run(killed ? 1 : 0, nowIso(), ventureId);
    if (Number(result.changes) !== 1) throw new Error(`venture not found: ${ventureId}`);
  }

  tableCounts(): Record<string, number> {
    const tables = [
      "ventures",
      "pack_revisions",
      "source_snapshots",
      "evidence",
      "transition_requests",
      "tasks",
      "jobs",
      "dispatches",
      "receipts",
      "approvals",
      "metrics",
      "audit_events",
      "goal_revisions",
      "goal_revision_receipts",
      "decision_traces",
      "decision_trace_receipts",
      "evaluation_contracts",
      "evaluation_baseline_receipts",
      "experiment_records",
      "experiment_receipts",
      "skill_versions",
      "skill_version_evaluations",
      "skill_version_experiments",
      "skill_version_evidence",
      "play_promotions",
      "play_promotion_experiments",
      "play_promotion_evaluations",
      "play_promotion_evidence",
      "play_promotion_receipts"
    ];
    return Object.fromEntries(
      tables.map((table) => [table, (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count])
    );
  }
}

export function migrationManifest(): Array<{ version: number; name: string }> {
  return MIGRATIONS.map(({ version, name }) => ({ version, name }));
}

export * from "./kernel.js";
