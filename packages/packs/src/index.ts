import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  SCHEMA_VERSION,
  VenturePackSchema,
  canonicalize,
  sha256,
  type LifecycleState,
  type ReadinessGap,
  type SourceHealth,
  type VenturePack
} from "@opspot/contracts";

export interface LoadedPack {
  pack: VenturePack;
  canonicalJson: string;
  canonicalHash: string;
  sourcePath: string;
  migratedFrom?: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function migratePack(raw: unknown): { value: unknown; migratedFrom?: string } {
  if (!raw || typeof raw !== "object") return { value: raw };
  const input = structuredClone(raw) as Record<string, unknown>;
  if (input.schemaVersion === SCHEMA_VERSION) return { value: input };

  if (input.schemaVersion === "0.9.0") {
    input.schemaVersion = SCHEMA_VERSION;
    const policy = (input.policy ?? {}) as Record<string, unknown>;
    policy.dataRetention ??= "Engine metadata and receipts retained indefinitely; authoritative truth remains at source.";
    input.policy = policy;
    return { value: input, migratedFrom: "0.9.0" };
  }

  return { value: input };
}

export async function loadPack(packPath: string, venturesRoot: string): Promise<LoadedPack> {
  const [rootReal, fileReal] = await Promise.all([realpath(venturesRoot), realpath(packPath)]);
  if (!isWithin(rootReal, fileReal)) throw new Error(`pack path escapes ventures root: ${packPath}`);
  const extension = path.extname(fileReal).toLowerCase();
  if (![".yaml", ".yml", ".json"].includes(extension)) throw new Error(`unsupported pack extension: ${extension}`);

  const text = await readFile(fileReal, "utf8");
  const raw = extension === ".json" ? JSON.parse(text) : YAML.parse(text);
  const migrated = migratePack(raw);
  const parsed = VenturePackSchema.safeParse(migrated.value);
  if (!parsed.success) {
    throw new Error(`invalid Venture Pack ${fileReal}: ${z.prettifyError(parsed.error)}`);
  }
  const canonicalJson = canonicalize(parsed.data);
  return {
    pack: parsed.data,
    canonicalJson,
    canonicalHash: sha256(canonicalJson),
    sourcePath: fileReal,
    ...(migrated.migratedFrom ? { migratedFrom: migrated.migratedFrom } : {})
  };
}

export function venturePackJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(VenturePackSchema, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>;
}

const blockingStatesByGroup: Record<ReadinessGap["group"], LifecycleState[]> = {
  buyer: ["validating", "offer-ready", "launch-ready", "externally-live", "revenue-verified", "fulfillment-verified", "scaling"],
  offer: ["offer-ready", "launch-ready", "externally-live", "revenue-verified", "fulfillment-verified", "scaling"],
  acquisition: ["launch-ready", "externally-live", "revenue-verified", "fulfillment-verified", "scaling"],
  product: ["launch-ready", "externally-live", "revenue-verified", "fulfillment-verified", "scaling"],
  payment: ["launch-ready", "revenue-verified", "fulfillment-verified", "scaling"],
  fulfillment: ["launch-ready", "fulfillment-verified", "scaling"],
  policy: ["launch-ready", "externally-live", "revenue-verified", "fulfillment-verified", "scaling"],
  economics: ["scaling"],
  proof: ["validating", "offer-ready", "launch-ready", "externally-live", "revenue-verified", "fulfillment-verified", "scaling"]
};

function isAssertionStale(observedAt: string | undefined, freshForHours: number | undefined, now: Date): boolean {
  if (!observedAt || freshForHours === undefined) return false;
  return new Date(observedAt).getTime() + freshForHours * 3_600_000 < now.getTime();
}

export function computeReadiness(pack: VenturePack, sourceHealth: SourceHealth[], now = new Date()): ReadinessGap[] {
  const health = new Map(sourceHealth.map((item) => [item.sourceRef, item]));
  const gaps: ReadinessGap[] = [];

  for (const [groupName, assertions] of Object.entries(pack.assertions)) {
    const group = groupName as ReadinessGap["group"];
    for (const [field, assertion] of Object.entries(assertions)) {
      if (assertion.status === "not-applicable") continue;
      let reason: ReadinessGap["reason"] | undefined;
      if (assertion.status === "missing") reason = "missing";
      else if (assertion.status === "hypothesis") reason = "hypothesis";
      else if (isAssertionStale(assertion.observedAt, assertion.freshForHours, now)) reason = "stale";
      else {
        const referenced = assertion.sourceRefs.map((sourceRef) => health.get(sourceRef)).filter(Boolean) as SourceHealth[];
        if (referenced.some((item) => item.status === "conflicting")) reason = "conflicting";
        else if (referenced.some((item) => item.status === "stale" || item.status === "superseded")) reason = "stale";
        else if (assertion.sourceRefs.length > 0 && (referenced.length !== assertion.sourceRefs.length || referenced.some((item) => item.status === "unavailable"))) {
          reason = "unavailable";
        }
      }
      if (reason) {
        gaps.push({
          ventureId: pack.venture.id,
          group,
          field,
          reason,
          sourceRefs: [...assertion.sourceRefs],
          blockingStates: [...blockingStatesByGroup[group]]
        });
      }
    }
  }

  return gaps.sort((left, right) => `${left.group}:${left.field}`.localeCompare(`${right.group}:${right.field}`));
}

export function assertPackIsolation(pack: VenturePack, forbiddenTerms: string[]): void {
  const text = canonicalize(pack).toLowerCase();
  const hit = forbiddenTerms.find((term) => term.length > 2 && text.includes(term.toLowerCase()));
  if (hit) throw new Error(`venture pack ${pack.venture.id} contains forbidden cross-venture term: ${hit}`);
}
