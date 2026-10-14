import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { readSupabaseServerConfig } from "./config";

export async function createServerSupabaseClient() {
  if (typeof window !== "undefined") throw new Error("the Supabase cookie client is server-only");
  const config = readSupabaseServerConfig();
  const cookieStore = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
      }
    }
  });
}
