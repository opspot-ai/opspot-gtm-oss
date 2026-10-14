---
name: verify-business-proof
description: Reconcile provider outcomes while keeping hosted subscription revenue, operated-company revenue, and fulfillment proof in separate ledgers.
metadata:
  version: 1.0.0
---

# Verify Business Proof

## Trigger

Use when a signed payment, email, fulfillment, analytics, or generic webhook changes the evidence available to a company.

## Inputs

Raw signed event, provider event ID and timestamp, workspace and company bindings, ledger namespace, named authoritative object, and the provider credential available only to the scoped worker.

## Procedure

1. Verify the raw signature and freshness before parsing.
2. Reject missing or conflicting workspace, company, namespace, amount, currency, or object bindings.
3. Deduplicate by provider event ID and order changes by the authoritative object, not delivery time.
4. Re-read the named object from its authoritative provider.
5. Persist test events as test proof and generic attestations as unverified provenance only.
6. Upgrade revenue or fulfillment only for a live settled payment or owning-system delivery confirmation.
7. Apply refunds, disputes, cancelation, bounce, complaint, unsubscribe, and revocation to the matching ledger idempotently.
8. Re-run the CEO loop only when the new evidence is material.

## Output

An append-only provider event, explicit proof tier, separate ledger transition, evidence and receipt references, and a bounded replan trigger.

## Verification

Replay duplicate and out-of-order events. Confirm a test event, reply, checkout view, generic attestation, or payment alone cannot claim live revenue plus fulfillment. Confirm workspace A cannot reference workspace B's event or object.

## Failure handling

Quarantine signature, binding, ordering, or reconciliation failures at the lower proof tier. Never retry an unknown external effect blindly; route it to reconciliation or dead-letter visibility.

## Learning hooks

Add every new provider failure shape to a frozen evaluation set. A provider parser or fulfillment play may be promoted only after independent replay, ordering, isolation, and negative-case review.
