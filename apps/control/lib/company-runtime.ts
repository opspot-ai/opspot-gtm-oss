import { CompanyCommandService, createCloudCompanyRuntime, createDefaultRuntime } from "@opspot/domain";
import { SqliteKernelStorage } from "@opspot/storage";
import { LOCAL_WORKSPACE_ID, localExecutionContext } from "@opspot/contracts";
import { getCloudKernelStorage } from "./kernel-storage";

export type EngineMode = "local" | "cloud";

export function readEngineMode(environment: NodeJS.ProcessEnv = process.env): EngineMode {
  if (environment.ENGINE_MODE !== "local" && environment.ENGINE_MODE !== "cloud") {
    throw new Error("ENGINE_MODE must be explicitly set to local or cloud");
  }
  return environment.ENGINE_MODE;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nonnegativeInteger(environment: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(environment, name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function readOptionalResendExecutionConfig(environment: NodeJS.ProcessEnv) {
  const values = [environment.RESEND_API_KEY, environment.RESEND_WEBHOOK_SECRET, environment.RESEND_ACQUISITION_FROM, environment.RESEND_ACQUISITION_TO, environment.RESEND_OWNED_INBOUND_RECIPIENT];
  if (values.some(Boolean) && !values.every(Boolean)) throw new Error("Resend golden execution requires API key, webhook secret, sender, owned recipient, and owned reply recipient together");
  return values.every(Boolean)
    ? { resendApiKey: values[0]!, resendSender: values[2]!, resendOwnedRecipient: values[3]!, resendOwnedReplyRecipient: values[4]! }
    : {};
}

export function readOptionalPublicOfferConfig(environment: NodeJS.ProcessEnv) {
  const values = [environment.PUBLIC_OFFER_SLUG_KEY, environment.PUBLIC_OFFER_SLUG_KEY_ID];
  if (values.some(Boolean) && !values.every(Boolean)) throw new Error("public offer slug key and key id are required together");
  if (!values.every(Boolean)) return {};
  const key = Buffer.from(values[0]!, "base64url");
  if (key.byteLength !== 32) throw new Error("PUBLIC_OFFER_SLUG_KEY must decode to exactly 32 bytes");
  return { publicOfferSlugKey: key, publicOfferSlugKeyId: values[1]! };
}

export async function createConfiguredCloudCompanyRuntime(workspaceId: string, environment: NodeJS.ProcessEnv = process.env) {
  return createCloudCompanyRuntime({
    storage: await getCloudKernelStorage(),
    workspaceId,
    openAiApiKey: required(environment, "OPENAI_API_KEY"),
    webSearchCostCents: nonnegativeInteger(environment, "OPENAI_WEB_SEARCH_COST_CENTS"),
    ...readOptionalResendExecutionConfig(environment),
    ...readOptionalPublicOfferConfig(environment),
    ...(environment.OPENAI_CEO_MODEL ? { ceoModel: environment.OPENAI_CEO_MODEL } : {}),
    ...(environment.OPENAI_INITIATIVE_MODEL ? { initiativeModel: environment.OPENAI_INITIATIVE_MODEL } : {})
  });
}

export function createLocalCompanyRuntime(root: string) {
  const context = localExecutionContext("api");
  const runtime = createDefaultRuntime({ root, context });
  const storage = new SqliteKernelStorage(runtime.storage);
  const service = new CompanyCommandService(storage, runtime.autonomy);
  return { workspaceId: LOCAL_WORKSPACE_ID, storage, service, runtime, close: () => runtime.storage.close() };
}
