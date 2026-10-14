---
name: bootstrap-company
description: Create a bounded company, operating envelope, and first evidence-seeking initiative from a founder's plain-language input without inventing market truth.
metadata:
  version: 1.0.0
---

# Bootstrap Company

## Trigger

Use when a founder supplies a new idea or imports an existing offer through the CLI or MCP surface.

## Inputs

Company idea, owner, destination, horizon, budget, constraints, kill conditions, and explicit permissions. Sender, recipient, publication, credential, and spend authority must be structured fields backed by provider evidence; free text never grants authority.

## Procedure

1. Call `company.bootstrap` once with a stable idempotency key.
2. Preserve buyer, offer, price, channel, payment, and fulfillment claims as hypotheses or unknowns unless current evidence supports them.
3. Review the returned company ID, immutable bootstrap digest, goal, operating envelope, and initial initiative.
4. Narrow any excessive authority before calling `company.run`.
5. Run only after the budget, stop conditions, and exact approval boundary are correct.

## Output

A tenant-scoped company, initial goal and initiative, bootstrap evidence and receipt, local or trial entitlement, and a durable Run boundary.

## Verification

Replay the bootstrap with the same idempotency key and confirm it returns the same company. Export it and verify unknown business outcomes remain unknown, no plaintext credential appears, and no task or receipt was pre-seeded.

## Failure handling

Reject invalid or conflicting input. If evidence or authority is missing, preserve the gap and abstain; never fill it with plausible text or broaden permissions.

## Learning hooks

Keep failed bootstrap inputs as private evaluation cases. Change defaults only after independent held-out evaluation; never learn authority or business proof from model output.
