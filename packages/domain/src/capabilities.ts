import type {
  EvidenceItem,
  GateClass,
  GtmCapabilityId,
  InitiativeCandidate,
  OperatingEnvelope
} from "@opspot/contracts";

export const GTM_CAPABILITY_CATALOG_VERSION = "2026-07-20.1" as const;

export type GoldenExecutionClass = "initiative-execution" | "golden-execution";
export type GoldenAuthorityDisposition = "internal-safe" | "preauthorized" | "approval-required";

export interface GtmCapability {
  id: GtmCapabilityId;
  trigger: string;
  inputs: readonly string[];
  authority: string;
  procedure: readonly string[];
  outputs: readonly string[];
  evidencePrerequisites: readonly string[];
  expectedProof: readonly string[];
  budgets: readonly string[];
  stopConditions: readonly string[];
  failureHandling: string;
  learningHooks: string;
  gateClasses: readonly GateClass[];
}

export const GTM_CAPABILITY_CATALOG: readonly GtmCapability[] = Object.freeze([
  {
    id: "company-evidence-bootstrap",
    trigger: "A founder supplies a new idea or imports an existing company.",
    inputs: ["Founder narrative", "destination", "budget", "constraints", "kill conditions", "operating envelope"],
    authority: "Founder-supplied company truth only; unknowns stay unknown.",
    procedure: ["Persist the immutable company envelope", "separate assertions from evidence", "create the first goal and initiative"],
    outputs: ["Company state", "venture pack", "bootstrap receipt", "initial goal and initiative"],
    evidencePrerequisites: [],
    expectedProof: ["Current company-bootstrap evidence bound to the company and founder input"],
    budgets: ["Use the founder budget; create no external effect"],
    stopConditions: ["Stop if the company identity, owner, or operating envelope is invalid"],
    failureHandling: "Reject invalid input or persist an explicit unknown; never infer accounts, authority, or proof.",
    learningHooks: "Record bootstrap failures as evaluation cases without changing the frozen source input.",
    gateClasses: ["safe-internal-read-only"]
  },
  {
    id: "market-problem-research",
    trigger: "The market problem or buyer remains unsupported, ambiguous, or stale.",
    inputs: ["Company bootstrap", "current sources", "market and problem hypotheses"],
    authority: "Owned or public research only; citations support statements but do not prove demand.",
    procedure: ["Search primary sources", "seek falsifying evidence", "label supported, hypothesis, and unknown findings"],
    outputs: ["Cited research artifact", "falsification result", "named evidence gaps"],
    evidencePrerequisites: ["company-bootstrap"],
    expectedProof: ["Task-bound artifact with provider-annotated citations for supported public findings"],
    budgets: ["Stay inside model and research-tool ceilings"],
    stopConditions: ["Stop before outreach, purchase, publication, or unsupported claims"],
    failureHandling: "Return inconclusive findings and missing evidence instead of manufacturing market support.",
    learningHooks: "Freeze failed queries and citation-quality cases for independent evaluation.",
    gateClasses: ["safe-internal-read-only", "public-research-free", "paid-research"]
  },
  {
    id: "icp-offer-positioning-pricing",
    trigger: "Current problem evidence exists but ICP, offer, positioning, price, or claims are unresolved.",
    inputs: ["Market/problem evidence", "company constraints", "approved and prohibited claims"],
    authority: "Prepare bounded hypotheses; only current evidence may support a claim.",
    procedure: ["Define a narrow ICP", "draft offer, position, price, and claim boundaries", "name falsification tests"],
    outputs: ["ICP", "offer", "positioning", "price hypothesis", "claim ledger"],
    evidencePrerequisites: ["capability:market-problem-research"],
    expectedProof: ["Internal artifact that cites inputs and preserves every unsupported item as a hypothesis"],
    budgets: ["Stay inside model and research-tool ceilings"],
    stopConditions: ["Stop before unfamiliar claims, publication, or customer commitment"],
    failureHandling: "Abstain when research cannot support an honest offer or price test.",
    learningHooks: "Compare offer variants only under a frozen evaluation contract.",
    gateClasses: ["safe-internal-read-only", "paid-research"]
  },
  {
    id: "paid-demand-validation",
    trigger: "An evidence-backed offer needs an honest willingness-to-pay test.",
    inputs: ["Offer and price hypothesis", "permissioned audience", "payment and fulfillment assertions"],
    authority: "Prepare internally or act only through a frozen operating envelope or exact approval.",
    procedure: ["Choose the smallest honest demand test", "enforce claims and recipient bounds", "observe authoritative outcomes"],
    outputs: ["Demand-test asset", "permissioned action receipt", "positive, negative, or inconclusive result"],
    evidencePrerequisites: ["capability:icp-offer-positioning-pricing"],
    expectedProof: ["Provider action receipts plus authoritative buyer/payment evidence; an agent artifact is not demand proof"],
    budgets: ["Enforce action, tool, and operating caps before every effect"],
    stopConditions: ["Stop at caps, suppression, expiry, unsupported claims, or missing fulfillment truth"],
    failureHandling: "Record negative or inconclusive demand and route a pivot/kill decision; never label a reply or checkout view as payment.",
    learningHooks: "Evaluate demand-test variants against frozen authoritative outcomes.",
    gateClasses: ["safe-internal-read-only", "external-send-within-license", "external-send-above-license", "public-posting", "money-movement", "unfamiliar-claim"]
  },
  {
    id: "minimum-sellable-asset",
    trigger: "The current offer is ready for the smallest asset that can support a truthful sale and fulfillment.",
    inputs: ["Offer", "claims", "price", "payment route", "fulfillment route", "deployment boundary"],
    authority: "Create internal assets safely; deployment or publication follows the operating envelope and explicit gates.",
    procedure: ["Build the minimum asset", "wire checkout and fulfillment assertions", "verify accessibility and truth states"],
    outputs: ["Sellable asset", "landing or checkout surface", "deployment and rollback receipt"],
    evidencePrerequisites: ["capability:icp-offer-positioning-pricing"],
    expectedProof: ["Artifact digest and route checks; only a real reachable surface may earn externally-live"],
    budgets: ["Stay inside build, provider, and deployment ceilings"],
    stopConditions: ["Stop before unsupported publication, unverified payment claims, or unavailable fulfillment"],
    failureHandling: "Keep the artifact internal and surface the exact missing deployment or account gate.",
    learningHooks: "Promote asset patterns only after held-out and cross-company evidence.",
    gateClasses: ["safe-internal-read-only", "public-posting", "client-system-mutation"]
  },
  {
    id: "permissioned-acquisition",
    trigger: "A sellable asset exists and one maintained acquisition channel is authorized.",
    inputs: ["Asset", "sender identity", "channel", "recipient rules", "suppressions", "caps", "quiet hours"],
    authority: "Only exact within-envelope sends are preauthorized; all other acquisition waits for exact approval.",
    procedure: ["Resolve eligible recipients", "enforce suppression and caps", "send idempotently", "capture provider events"],
    outputs: ["Send or publication receipts", "delivery, bounce, complaint, unsubscribe, and reply events"],
    evidencePrerequisites: ["capability:minimum-sellable-asset"],
    expectedProof: ["Provider receipts bound to sender, channel, recipient rule, suppression decision, and idempotency key"],
    budgets: ["Enforce daily, weekly, tool, and operating caps atomically"],
    stopConditions: ["Stop on kill, suppression, abuse, cap, quiet hours, expiry, or sender-verification failure"],
    failureHandling: "Fail closed, preserve the provider error, and never retry an unresolved external effect blindly.",
    learningHooks: "Use authoritative provider outcomes in bounded channel experiments.",
    gateClasses: ["external-send-within-license", "external-send-above-license", "public-posting", "paid-research"]
  },
  {
    id: "reply-qualification-next-action",
    trigger: "A permissioned channel emits an inbound reply or lead event.",
    inputs: ["Inbound provider event", "conversation history", "claims", "qualification and suppression rules"],
    authority: "Classification is internal; any outbound next action must stay within the frozen envelope or exact approval.",
    procedure: ["Verify event provenance", "classify intent and objection", "select or gate the next action"],
    outputs: ["Qualification", "objection", "suppression update", "bounded next action"],
    evidencePrerequisites: ["capability:permissioned-acquisition"],
    expectedProof: ["Signed provider event and task-bound classification; a lead or reply is not revenue"],
    budgets: ["Enforce action caps and model/tool ceilings"],
    stopConditions: ["Stop on unsubscribe, complaint, prohibited claim, negotiation, or missing conversation authority"],
    failureHandling: "Quarantine unverifiable events and request the minimum exact human decision.",
    learningHooks: "Freeze labeled replies and outcomes before promoting classifiers or response plays.",
    gateClasses: ["safe-internal-read-only", "external-send-within-license", "unfamiliar-claim"]
  },
  {
    id: "checkout-payment-observation",
    trigger: "Checkout or the named payment provider emits a company-customer payment state change.",
    inputs: ["Signed provider event", "company ledger namespace", "authoritative payment object"],
    authority: "Observe and reconcile only; money movement and account mutation remain exact gates.",
    procedure: ["Verify signature and replay key", "reconcile with the named provider", "update only the operated-company ledger"],
    outputs: ["Payment, refund, dispute, or cancelation evidence", "ledger transition"],
    evidencePrerequisites: ["capability:minimum-sellable-asset"],
    expectedProof: ["Authoritative provider reconciliation; generic attestations alone remain unverified"],
    budgets: ["No money movement; provider-read cost must stay within tool ceilings"],
    stopConditions: ["Stop on signature, namespace, amount, currency, order, or reconciliation mismatch"],
    failureHandling: "Quarantine conflicting events and retain the lower proof tier until authoritative reconciliation succeeds.",
    learningHooks: "Add duplicate, out-of-order, refund, and dispute cases to frozen payment evaluations.",
    gateClasses: ["safe-internal-read-only", "client-system-mutation", "money-movement"]
  },
  {
    id: "fulfillment-verification",
    trigger: "Authoritative operated-company payment requires delivery of the supported digital promise.",
    inputs: ["Authoritative payment evidence", "promise", "fulfillment target", "owning-system connector"],
    authority: "Provision only inside the exact customer-system envelope or approval; verification comes from the owning system.",
    procedure: ["Bind payment to promise", "deliver idempotently", "reconcile owning-system confirmation"],
    outputs: ["Delivery receipt", "authoritative fulfillment evidence", "failure or rollback state"],
    evidencePrerequisites: ["authoritative-payment-collected"],
    expectedProof: ["Owning-system confirmation; generic signed fulfillment attestations remain unverified until reconciled"],
    budgets: ["Enforce operating/tool ceilings and one effect per payment/promise key"],
    stopConditions: ["Stop on payment ambiguity, promise mismatch, kill, credential scope, or unsafe mutation"],
    failureHandling: "Do not mark delivered; preserve the failed effect and route a bounded recovery or exact approval.",
    learningHooks: "Evaluate fulfillment plays against authoritative delivery and support outcomes.",
    gateClasses: ["safe-internal-read-only", "client-system-mutation"]
  },
  {
    id: "retention-renewal-observation",
    trigger: "Fulfillment exists and a renewal, use, churn, refund, or retention signal arrives.",
    inputs: ["Authoritative fulfillment", "subscription/payment state", "product or service usage signal"],
    authority: "Observe internally; outbound retention actions require envelope authority or exact approval.",
    procedure: ["Verify source", "classify retention state", "link outcome to the promise and next decision"],
    outputs: ["Retention, renewal, churn, or unresolved evidence", "bounded next action"],
    evidencePrerequisites: ["authoritative-fulfillment-delivered"],
    expectedProof: ["Authoritative billing, usage, or owning-system event; inference alone is not retention proof"],
    budgets: ["Enforce action and model/tool ceilings"],
    stopConditions: ["Stop on disputed identity, unsupported inference, suppression, or negotiation"],
    failureHandling: "Keep the signal unresolved and request the named authoritative source.",
    learningHooks: "Freeze retention cohorts and outcomes before promoting interventions.",
    gateClasses: ["safe-internal-read-only", "external-send-within-license", "client-system-mutation"]
  },
  {
    id: "pivot-kill-scale-decision",
    trigger: "Material evidence, a kill condition, or repeatable economics changes the company decision.",
    inputs: ["Current company truth", "material evidence", "budget", "kill conditions", "alternatives"],
    authority: "The CEO may recommend and pause; permanent kill, unfamiliar scale spend, and high-blast changes remain founder gates.",
    procedure: ["Generate alternatives", "compare evidence and stop conditions", "select, abstain, pause, pivot, or recommend scale"],
    outputs: ["Decision trace", "next initiative", "exact gate or stop recommendation"],
    evidencePrerequisites: ["company-bootstrap"],
    expectedProof: ["Immutable evidence-bound decision trace; no fabricated success, revenue, or fulfillment"],
    budgets: ["Never exceed the company or operating envelope"],
    stopConditions: ["Abstain on missing evidence or authority; pause rather than autonomously killing"],
    failureHandling: "Preserve the prior valid state, record the failure, and schedule a bounded re-observation.",
    learningHooks: "Evaluate materially different and wording-invariant cases under a frozen decision contract.",
    gateClasses: ["safe-internal-read-only", "public-posting", "money-movement", "client-system-mutation"]
  },
  {
    id: "frozen-evaluation-skill-promotion",
    trigger: "A repeatable play or capability change is proposed for promotion.",
    inputs: ["Frozen evaluator", "baseline", "held-out or authoritative outcomes", "candidate artifact", "independent review"],
    authority: "Evaluation is read-only; a skill cannot evaluate or promote itself.",
    procedure: ["Freeze inputs and metrics", "run bounded experiment", "independently review", "keep, discard, or remain inconclusive"],
    outputs: ["Evaluation receipts", "disposition", "candidate or promoted skill version"],
    evidencePrerequisites: ["company-bootstrap"],
    expectedProof: ["Frozen hashes, held-out or authoritative results, and independent reviewer receipt"],
    budgets: ["Enforce experiment attempts, elapsed time, cost, and reviewer ceilings"],
    stopConditions: ["Stop on leakage, evaluator drift, missing baseline, self-review, or hard-gate failure"],
    failureHandling: "Keep the skill draft/candidate and record the failed or inconclusive experiment append-only.",
    learningHooks: "Promotion itself is the learning hook and requires new frozen evidence for every revision.",
    gateClasses: ["safe-internal-read-only", "paid-research"]
  }
] satisfies readonly GtmCapability[]);

export const GTM_CAPABILITY_PROMPT_CATALOG = Object.freeze(GTM_CAPABILITY_CATALOG.map((capability) => ({
  id: capability.id,
  trigger: capability.trigger,
  evidencePrerequisites: capability.evidencePrerequisites,
  allowedGateClasses: capability.gateClasses,
  authority: capability.authority,
  expectedProof: capability.expectedProof.join(" "),
  stop: capability.stopConditions.join(" ")
})));

const CAPABILITIES_BY_ID = new Map(GTM_CAPABILITY_CATALOG.map((capability) => [capability.id, capability]));
const INTERNAL_EXECUTION_GATES = new Set<GateClass>(["safe-internal-read-only", "public-research-free", "paid-research"]);
export const EXTERNAL_SEND_EVIDENCE_PREREQUISITES = Object.freeze([
  "provider-verified-sender-domain",
  "provider-verified-suppression-control",
  "provider-verified-owned-recipient-endpoint"
]);
export const PUBLIC_OFFER_DEPLOYMENT_BOUNDARY = "opspot-public-offer-route";

export function getGtmCapability(id: GtmCapabilityId): GtmCapability {
  return CAPABILITIES_BY_ID.get(id)!;
}

export function capabilityEvidencePrerequisites(capability: GtmCapability, gate: GateClass | undefined): readonly string[] {
  return gate?.startsWith("external-send-")
    ? [...capability.evidencePrerequisites, ...EXTERNAL_SEND_EVIDENCE_PREREQUISITES]
    : capability.evidencePrerequisites;
}

export function evidenceSatisfiesCapabilityPrerequisite(prerequisite: string, evidence: readonly EvidenceItem[]): boolean {
  return evidence.some((item) => {
    if (item.status !== "current" || item.authority === "fixture" || item.metadata.fixture === true) return false;
    if (prerequisite.startsWith("capability:")) return item.metadata.capabilityId === prerequisite.slice("capability:".length);
    if (prerequisite === "authoritative-payment-collected") {
      return item.type === prerequisite && item.authority === "payment" && item.proofTier === "revenue-verified";
    }
    if (prerequisite === "authoritative-fulfillment-delivered") {
      return item.type === prerequisite && item.authority === "fulfillment" && item.proofTier === "fulfillment-verified";
    }
    return item.type === prerequisite;
  });
}

export interface GtmCapabilityAssessment {
  capability: GtmCapability;
  gateConsistent: boolean;
  evidenceReady: boolean;
  evidencePrerequisites: readonly string[];
  missingEvidencePrerequisites: string[];
  executionClass: GoldenExecutionClass;
  authorityDisposition: GoldenAuthorityDisposition;
  authorityReasons: string[];
}

export function assessGtmCapability(
  candidate: InitiativeCandidate,
  envelope: OperatingEnvelope,
  evidence: readonly EvidenceItem[],
  at: string
): GtmCapabilityAssessment {
  const capability = getGtmCapability(candidate.capabilityId);
  const gate = candidate.gateClasses.length === 1 ? candidate.gateClasses[0] : undefined;
  const gateConsistent = Boolean(gate && capability.gateClasses.includes(gate));
  const evidencePrerequisites = capabilityEvidencePrerequisites(capability, gate);
  const missingEvidencePrerequisites = evidencePrerequisites.filter(
    (prerequisite) => !evidenceSatisfiesCapabilityPrerequisite(prerequisite, evidence)
  );
  const executionClass = gate && INTERNAL_EXECUTION_GATES.has(gate) ? "initiative-execution" : "golden-execution";
  const authorityReasons: string[] = [];
  if (!gate) authorityReasons.push("candidate must declare exactly one gate class");
  else if (!gateConsistent) authorityReasons.push(`gate ${gate} is not valid for capability ${capability.id}`);

  let authorityDisposition: GoldenAuthorityDisposition = "approval-required";
  if (gateConsistent && gate && INTERNAL_EXECUTION_GATES.has(gate)) {
    const paidResearchWithinBudget = gate !== "paid-research"
      || (candidate.estimatedCostCents > 0 && candidate.estimatedCostCents <= envelope.toolBudgetCents);
    if (paidResearchWithinBudget) authorityDisposition = "internal-safe";
    else authorityReasons.push("paid research is not inside the persisted tool budget");
  } else if (gateConsistent && gate === "external-send-within-license") {
    const envelopeExpired = envelope.expiresAt !== undefined && Date.parse(envelope.expiresAt) <= Date.parse(at);
    const exactWithinEnvelope = candidate.autonomyMode === "execute-gated"
      && !envelopeExpired
      && missingEvidencePrerequisites.length === 0
      && envelope.allowedChannels.length > 0
      && envelope.senderIdentities.length > 0
      && envelope.recipientRules.length > 0
      && envelope.suppressions.length > 0
      && envelope.dailyActionCap > 0
      && envelope.weeklyActionCap > 0;
    if (exactWithinEnvelope) authorityDisposition = "preauthorized";
    else {
      if (candidate.autonomyMode !== "execute-gated") authorityReasons.push("external execution was not requested as execute-gated");
      if (envelopeExpired) authorityReasons.push("operating envelope expired");
      if (envelope.allowedChannels.length === 0) authorityReasons.push("no allowed channel");
      if (envelope.senderIdentities.length === 0) authorityReasons.push("no sender identity");
      if (envelope.recipientRules.length === 0) authorityReasons.push("no recipient rule");
      if (envelope.suppressions.length === 0) authorityReasons.push("no suppression source");
      if (envelope.dailyActionCap === 0 || envelope.weeklyActionCap === 0) authorityReasons.push("action cap is zero");
      if (missingEvidencePrerequisites.length > 0) authorityReasons.push("provider verification or capability evidence is missing");
    }
  } else if (gateConsistent && gate === "public-posting" && capability.id === "minimum-sellable-asset") {
    const envelopeExpired = envelope.expiresAt !== undefined && Date.parse(envelope.expiresAt) <= Date.parse(at);
    const offerAuthorityProblems = publicOfferAuthorityProblems(envelope);
    const exactWithinEnvelope = candidate.autonomyMode === "execute-gated"
      && !envelopeExpired
      && missingEvidencePrerequisites.length === 0
      && envelope.publicationAllowed
      && envelope.deploymentBoundaries.includes(PUBLIC_OFFER_DEPLOYMENT_BOUNDARY)
      && offerAuthorityProblems.length === 0;
    if (exactWithinEnvelope) authorityDisposition = "preauthorized";
    else {
      if (candidate.autonomyMode !== "execute-gated") authorityReasons.push("public offer publication was not requested as execute-gated");
      if (envelopeExpired) authorityReasons.push("operating envelope expired");
      if (!envelope.publicationAllowed) authorityReasons.push("immutable publicationAllowed authority is false");
      if (!envelope.deploymentBoundaries.includes(PUBLIC_OFFER_DEPLOYMENT_BOUNDARY)) authorityReasons.push("exact product-owned public offer deployment boundary is absent");
      authorityReasons.push(...offerAuthorityProblems);
      if (missingEvidencePrerequisites.length > 0) authorityReasons.push("capability evidence is missing");
    }
  } else if (gateConsistent && gate) {
    authorityReasons.push(`gate ${gate} remains an exact approval gate`);
  }

  return {
    capability,
    gateConsistent,
    evidenceReady: missingEvidencePrerequisites.length === 0,
    evidencePrerequisites,
    missingEvidencePrerequisites,
    executionClass,
    authorityDisposition,
    authorityReasons
  };
}

export function preauthorizedEnvelopeBounds(envelope: OperatingEnvelope): Record<string, unknown> {
  return {
    senderIdentities: [...envelope.senderIdentities].sort(),
    allowedChannels: [...envelope.allowedChannels].sort(),
    recipientRules: [...envelope.recipientRules].sort(),
    suppressions: [...envelope.suppressions].sort(),
    dailyActionCap: envelope.dailyActionCap,
    weeklyActionCap: envelope.weeklyActionCap,
    quietHours: [...envelope.quietHours].sort(),
    approvedClaims: [...envelope.approvedClaims].sort(),
    prohibitedClaims: [...envelope.prohibitedClaims].sort(),
    deploymentBoundaries: [...envelope.deploymentBoundaries].sort(),
    publicationAllowed: envelope.publicationAllowed,
    publicOfferAuthority: envelope.publicOfferAuthority ?? null,
    expiresAt: envelope.expiresAt ?? null
  };
}

export function publicOfferAuthorityProblems(envelope: OperatingEnvelope): string[] {
  const authority = envelope.publicOfferAuthority;
  if (!authority) return ["exact immutable public offer fields are absent"];
  const approved = new Set(envelope.approvedClaims.map((claim) => claim.trim().toLocaleLowerCase()));
  const prohibited = envelope.prohibitedClaims.map((claim) => claim.trim().toLocaleLowerCase()).filter(Boolean);
  const claims = authority.claims.map((claim) => claim.trim().toLocaleLowerCase());
  const publicCopy = [authority.offerName, authority.publicSummary, authority.digitalPromise, ...authority.claims]
    .join("\n")
    .toLocaleLowerCase();
  const problems: string[] = [];
  if (claims.some((claim) => !approved.has(claim))) problems.push("public offer includes a claim outside immutable approvedClaims");
  if (prohibited.some((claim) => claims.includes(claim) || publicCopy.includes(claim))) problems.push("public offer includes an immutable prohibited claim");
  return problems;
}
