import { describe, expect, it } from "vitest";
import { readEngineMode, readOptionalPublicOfferConfig, readOptionalResendExecutionConfig } from "../apps/control/lib/company-runtime.js";

describe("optional cloud provider runtime configuration", () => {
  it("requires an explicit local or cloud provider boundary", () => {
    expect(readEngineMode({ NODE_ENV: "test", ENGINE_MODE: "local" } as NodeJS.ProcessEnv)).toBe("local");
    expect(readEngineMode({ NODE_ENV: "test", ENGINE_MODE: "cloud" } as NodeJS.ProcessEnv)).toBe("cloud");
    expect(() => readEngineMode({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toThrow(/explicitly set/);
    expect(() => readEngineMode({ NODE_ENV: "test", ENGINE_MODE: "development" } as NodeJS.ProcessEnv)).toThrow(/explicitly set/);
  });
  it("keeps internal CEO/initiative work available with no Resend values and rejects every partial execution configuration", () => {
    expect(readOptionalResendExecutionConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toEqual({});
    const full = { NODE_ENV: "test", RESEND_API_KEY: "re_live", RESEND_WEBHOOK_SECRET: "whsec_live", RESEND_ACQUISITION_FROM: "sender@example.test", RESEND_ACQUISITION_TO: "owned@example.test", RESEND_OWNED_INBOUND_RECIPIENT: "replies@inbound.example.test" } as NodeJS.ProcessEnv;
    expect(readOptionalResendExecutionConfig(full)).toEqual({ resendApiKey: "re_live", resendSender: "sender@example.test", resendOwnedRecipient: "owned@example.test", resendOwnedReplyRecipient: "replies@inbound.example.test" });
    for (const missing of ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "RESEND_ACQUISITION_FROM", "RESEND_ACQUISITION_TO", "RESEND_OWNED_INBOUND_RECIPIENT"]) {
      expect(() => readOptionalResendExecutionConfig({ ...full, [missing]: undefined })).toThrow(/requires API key, webhook secret, sender, owned recipient, and owned reply recipient together/);
    }
  });

  it("keeps public-offer slug crypto optional all-or-none and validates its key size", () => {
    expect(readOptionalPublicOfferConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toEqual({});
    expect(() => readOptionalPublicOfferConfig({ NODE_ENV: "test", PUBLIC_OFFER_SLUG_KEY_ID: "slug-v1" } as NodeJS.ProcessEnv)).toThrow(/together/);
    expect(() => readOptionalPublicOfferConfig({ NODE_ENV: "test", PUBLIC_OFFER_SLUG_KEY: Buffer.alloc(16).toString("base64url"), PUBLIC_OFFER_SLUG_KEY_ID: "slug-v1" } as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
    expect(readOptionalPublicOfferConfig({ NODE_ENV: "test", PUBLIC_OFFER_SLUG_KEY: Buffer.alloc(32).toString("base64url"), PUBLIC_OFFER_SLUG_KEY_ID: "slug-v1" } as NodeJS.ProcessEnv)).toMatchObject({ publicOfferSlugKeyId: "slug-v1" });
  });
});
