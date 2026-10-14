import type { DispatchResult, Receipt, SourceHealth, SourceReference, TaskDefinition, VenturePack } from "@opspot/contracts";

export interface DispatchContext {
  pack: VenturePack;
  receiptDestination: string;
  forbiddenTerms: string[];
  dependencyReceipts: Receipt[];
}

export interface RoleDispatcher {
  readonly name: string;
  supportsRole(role: string): boolean;
  dispatch(task: TaskDefinition, context: DispatchContext): Promise<DispatchResult>;
}

export interface SourceAdapter {
  inspect(ventureId: string, source: SourceReference): Promise<SourceHealth>;
  readText(ventureId: string, source: SourceReference, maxBytes?: number): Promise<string>;
}

export interface ReceiptWriter {
  write(input: {
    ventureId: string;
    receiptId: string;
    occurredAt: string;
    machine: Record<string, unknown>;
    markdown: string;
  }): Promise<{ jsonPath: string; markdownPath: string; contentHash: string }>;
}

export class DispatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchValidationError";
  }
}
