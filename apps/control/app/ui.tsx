"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type RecordValue = Record<string, unknown>;
type Result<T = RecordValue> = { ok: boolean; data?: T; error?: { message?: string } };

type CompanyState = {
  ventureId: string;
  lifecycleState: string;
  runState: string;
  bootstrap?: { snapshot?: {
    name?: string;
    destination?: string;
    budgetCents?: number;
    horizonDays?: number;
    assertions?: { unknowns?: string[] };
  } };
  currentInitiative?: {
    title?: string;
    capabilityId?: string;
    expectedOutcome?: string;
    expectedProof?: string;
    uncertaintyReason?: string;
    autonomyMode?: string;
    gateClasses?: string[];
  };
  pendingApprovalId?: string;
};

type Company = { ventureId: string; name: string; state: CompanyState; entitlement?: { status?: string; plan?: string; periodEnd?: string; spentCostCents?: number; modelCostCapCents?: number } | null };
type Approval = {
  id: string;
  taskId: string;
  actionDigest: string;
  status: string;
  expiresAt: string;
  packet: {
    recommendedAction: string;
    target: string;
    capOrCost: string;
    senderOrSystem: string;
    expiresAt: string;
    rollbackOrKillRoute: string;
    exactCommandOrProviderCall?: string;
  };
};
type CompanyDetail = {
  state: CompanyState;
  entitlement?: Company["entitlement"];
  evidence?: Array<{ proofTier?: string; type?: string; status?: string; authority?: string }>;
  receipts?: Array<{ proofTier?: string; outcome?: string }>;
  approvals?: Approval[];
  failedJobs?: Array<{ id: string; kind: string; status: string; attemptCount: number; updatedAt: string; error?: { redacted: true; at: string } }>;
};
type User = { email: string; local?: boolean };
type AuthResponse = { ok: boolean; user?: User | null; confirmationRequired?: boolean; error?: { code?: string; message?: string } | string };
type ProviderResponse = { ok: boolean; url?: string; error?: { message?: string } };

const destinations = [
  ["cash-flow", "Cash flow"],
  ["growth", "Growth"],
  ["exit-readiness", "Exit readiness"]
] as const;

const now = () => new Date().toISOString();
const key = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;
const money = (cents?: number) => cents === undefined ? "Not recorded" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
const label = (value?: string) => value ? value.replace(/[-_]/g, " ") : "Not recorded";
const dateTime = (value: string) => Number.isNaN(Date.parse(value)) ? value : new Date(value).toLocaleString();
const isLoopback = () => typeof window !== "undefined" && ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname);

async function command<T = RecordValue>(commandName: string, input: unknown): Promise<Result<T>> {
  try {
    const response = await fetch("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: commandName, input }) });
    const body = await response.json() as Result<T>;
    return body.ok ? body : { ok: false, error: body.error ?? { message: "The request was not accepted." } };
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : "Network request failed." } };
  }
}

async function auth(path: string, input?: unknown): Promise<AuthResponse> {
  try {
    const response = await fetch(`/api/auth/${path}`, input === undefined ? {} : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    return await response.json() as AuthResponse;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Network request failed." };
  }
}

async function provider(action: "checkout" | "portal", input: unknown): Promise<ProviderResponse> {
  try {
    const response = await fetch(`/api/providers/stripe/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    return await response.json() as ProviderResponse;
  } catch (error) {
    return { ok: false, error: { message: error instanceof Error ? error.message : "Network request failed." } };
  }
}

function authError(result: AuthResponse): string {
  return typeof result.error === "string" ? result.error : result.error?.message ?? "The request was not accepted.";
}

export function Dashboard() {
  const [user, setUser] = useState<User | null>();
  const [sessionError, setSessionError] = useState("");

  const loadSession = useCallback(async () => {
    setSessionError("");
    const result = await auth("session");
    if (!result.ok) {
      if (typeof result.error !== "string" && result.error?.code === "auth-required") {
        setUser(null);
        return;
      }
      if (typeof result.error !== "string" && result.error?.code === "auth-unavailable" && isLoopback()) {
        setUser({ email: "Local workspace", local: true });
        return;
      }
      setSessionError(authError(result));
      setUser(undefined);
      return;
    }
    setUser(result.user ?? null);
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);

  if (user === undefined) return <main className="auth-shell"><section className="auth-card" aria-busy="true"><p>Checking your session…</p>{sessionError && <><p className="error" role="alert">{sessionError}</p><button onClick={() => void loadSession()}>Try again</button></>}</section></main>;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  return <CloudDashboard user={user} onSignOut={() => setUser(null)} />;
}

function AuthScreen({ onAuthenticated }: { onAuthenticated: (user: User) => void }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "recover">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function changeMode(next: typeof mode) {
    setMode(next);
    setPassword("");
    setError("");
    setNotice("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const result = await auth(mode, mode === "recover" ? { email } : { email, password });
    if (!result.ok) { setError(authError(result)); setBusy(false); return; }
    if (mode === "recover") {
      setNotice("If an account matches that email, recovery instructions are on the way.");
      setBusy(false);
      return;
    }
    if (mode === "sign-up" && result.confirmationRequired) {
      setNotice("Account created. Check your email to confirm it, then log in.");
      setMode("sign-in");
      setPassword("");
      setBusy(false);
      return;
    }
    const session = result.user ? result : await auth("session");
    setBusy(false);
    if (session.ok && session.user) onAuthenticated(session.user);
    else setError(session.ok ? "Sign-in did not create a session. Please try again." : authError(session));
  }

  return <main className="auth-shell">
    <section className="auth-card" aria-labelledby="auth-title">
      <a className="auth-brand" href="#auth-title">OpSpot <span>GTM Cloud</span></a>
      <p className="eyebrow">Founder account</p>
      <h1 id="auth-title">{mode === "sign-in" ? "Welcome back" : mode === "sign-up" ? "Start operating" : "Recover access"}</h1>
      <p>{mode === "recover" ? "Enter the email on your account." : "Sign in to operate your company portfolio."}</p>
      {mode !== "recover" && <div className="auth-tabs" aria-label="Account action">
        <button type="button" aria-pressed={mode === "sign-in"} onClick={() => changeMode("sign-in")}>Log in</button>
        <button type="button" aria-pressed={mode === "sign-up"} onClick={() => changeMode("sign-up")}>Sign up</button>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <form onSubmit={submit} className="auth-form">
        <label>Email <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus /></label>
        {mode !== "recover" && <label>Password <input type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={8} required /></label>}
        <button className="primary" disabled={busy}>{busy ? "Working…" : mode === "sign-in" ? "Log in" : mode === "sign-up" ? "Create account" : "Send recovery email"}</button>
      </form>
      {mode === "sign-in" && <button className="text-button" type="button" onClick={() => changeMode("recover")}>Forgot password?</button>}
      {mode === "recover" && <button className="text-button" type="button" onClick={() => changeMode("sign-in")}>Back to login</button>}
    </section>
  </main>;
}

function CloudDashboard({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [form, setForm] = useState({
    name: "",
    idea: "",
    owner: "Founder",
    destination: "cash-flow",
    horizonDays: "90",
    budget: "10",
    senderIdentity: "",
    ownedRecipient: "",
    dailyActionCap: "1",
    weeklyActionCap: "2",
    permissions: "No external send, public post, deployment, credential mutation, or money movement outside this saved envelope without exact approval."
  });

  const refresh = useCallback(async (preferred?: string | null) => {
    setLoading(true);
    setError("");
    const list = await command<{ companies?: Company[] }>("company.list", {});
    if (!list.ok) {
      setCompanies([]);
      setDetail(null);
      setError(list.error?.message ?? "Companies could not be loaded.");
      setLoading(false);
      return;
    }
    const nextCompanies = list.data?.companies ?? [];
    const queryCompany = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("company");
    const requested = preferred ?? selected ?? queryCompany;
    const nextSelected = requested && nextCompanies.some((company) => company.ventureId === requested)
      ? requested
      : nextCompanies[0]?.ventureId ?? null;
    setCompanies(nextCompanies);
    setSelected(nextSelected);
    if (nextSelected) {
      const company = await command<CompanyDetail>("company.get", { ventureId: nextSelected });
      if (company.ok && (preferred ?? selected ?? nextSelected) === nextSelected) setDetail(company.data ?? null);
      else if (!company.ok) setError(company.error?.message ?? "This company could not be loaded.");
    } else setDetail(null);
    setLoading(false);
  }, [selected]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const checkout = new URLSearchParams(window.location.search).get("checkout");
    if (checkout === "success") setNotice("Checkout completed. Your plan will update only after Stripe sends a signed confirmation.");
    if (checkout === "cancelled") setNotice("Checkout was cancelled. Your current plan has not changed.");
  }, []);

  const current = useMemo(() => companies.find((company) => company.ventureId === selected) ?? null, [companies, selected]);
  const state = detail?.state ?? current?.state;
  const pendingApprovals = detail?.approvals?.filter((approval) => approval.status === "pending") ?? [];
  const currentEvidence = detail?.evidence?.filter((item) => item.status === "current") ?? [];
  const externalEvidence = currentEvidence.filter((item) => ["externally-live", "revenue-verified", "fulfillment-verified"].includes(item.proofTier ?? ""));
  const internalEvidence = currentEvidence.filter((item) => ["internally-live", "fixture-verified"].includes(item.proofTier ?? ""));
  const unknowns = state?.bootstrap?.snapshot?.assertions?.unknowns ?? [];
  const entitlement = detail?.entitlement;
  const canManageBilling = entitlement?.status === "active" || entitlement?.status === "paused" || entitlement?.status === "past-due";
  const costCapReached = entitlement?.spentCostCents !== undefined && entitlement.modelCostCapCents !== undefined && entitlement.spentCostCents >= entitlement.modelCostCapCents;
  const runtimeStatus = state?.runState === "running" ? "Autonomous work is running inside the saved envelope." : state?.runState === "killed" ? "The kill switch is active; this company cannot run." : costCapReached ? "Work is paused at the model-cost cap until the next entitled period." : pendingApprovals.length ? `${pendingApprovals.length} exact approval${pendingApprovals.length === 1 ? " is" : "s are"} waiting; unrelated safe work can continue.` : "Run starts bounded autonomous work; exceptions wait for exact approval.";

  async function createCompany(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setNotice("");
    const modelBudgetCents = Math.round(Number(form.budget) * 100);
    const senderIdentity = form.senderIdentity.trim().toLowerCase();
    const ownedRecipient = form.ownedRecipient.trim().toLowerCase();
    if (Boolean(senderIdentity) !== Boolean(ownedRecipient)) {
      setBusy("");
      setError("Enter both a verified sender and an inbox you own, or leave both blank for research-only autonomy.");
      return;
    }
    const acquisitionRequested = Boolean(senderIdentity && ownedRecipient);
    const result = await command<{ ventureId?: string }>("company.bootstrap", {
      name: form.name.trim() || undefined,
      idea: form.idea.trim(),
      owner: form.owner.trim(),
      destination: form.destination,
      horizonDays: Number(form.horizonDays),
      budgetCents: modelBudgetCents,
      constraints: [],
      killConditions: ["Stop when the bounded budget is exhausted without material demand evidence."],
      permissions: form.permissions.trim(),
      operatingEnvelope: {
        senderIdentities: senderIdentity ? [senderIdentity] : [],
        allowedChannels: acquisitionRequested ? ["email"] : [],
        recipientRules: ownedRecipient ? [`owned-endpoint:${ownedRecipient}`] : [],
        suppressions: acquisitionRequested ? ["provider-workspace-suppression-ledger"] : [],
        dailyActionCap: acquisitionRequested ? Number(form.dailyActionCap) : 0,
        weeklyActionCap: acquisitionRequested ? Number(form.weeklyActionCap) : 0,
        quietHours: ["22:00-08:00 America/New_York"],
        approvedClaims: [],
        prohibitedClaims: ["Any claim not explicitly supported by current company evidence"],
        modelBudgetCents,
        toolBudgetCents: 0,
        operatingBudgetCents: 0,
        credentialScopes: acquisitionRequested ? ["resend:send:workspace"] : [],
        deploymentBoundaries: [],
        publicationAllowed: false,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString()
      },
      requestedAt: now(),
      idempotencyKey: key("cloud-bootstrap")
    });
    setBusy("");
    if (!result.ok || !result.data?.ventureId) { setError(result.error?.message ?? "Company creation failed."); return; }
    setNotice("Company created. Review its initial initiative, then run when the operating envelope is right.");
    setForm((value) => ({ ...value, name: "", idea: "" }));
    await refresh(result.data.ventureId);
  }

  async function control(action: "company.run" | "company.pause" | "company.kill") {
    if (!selected) return;
    if (action === "company.kill" && !window.confirm("Kill this company? Its runtime will stop and cannot be resumed.")) return;
    setBusy(action);
    setNotice("");
    const result = action === "company.run"
      ? await command(action, { ventureId: selected, requestedAt: now(), idempotencyKey: key("cloud-run") })
      : await command(action, { ventureId: selected, reason: action === "company.kill" ? "Founder killed the company from Cloud." : "Founder paused the company from Cloud.", actor: "founder", requestedAt: now(), idempotencyKey: key("cloud-control") });
    setBusy("");
    if (!result.ok) { setError(result.error?.message ?? "The control request failed."); return; }
    setNotice(action === "company.run" ? "Run queued. The runtime will proceed only inside the saved permissions and budget." : action === "company.pause" ? "Company paused. No new runtime cycle will start." : "Company killed. This is final for the current company record.");
    await refresh(selected);
  }

  async function billing(action: "checkout" | "portal") {
    if (!selected) return;
    setBusy(`billing:${action}`);
    setError("");
    const result = await provider(action, { companyId: selected, idempotencyKey: key(`cloud-${action}`) });
    setBusy("");
    if (!result.ok || !result.url) { setError(result.error?.message ?? "Billing could not be opened."); return; }
    window.location.assign(result.url);
  }

  async function exportCompany() {
    if (!selected || !current) return;
    setBusy("company.export");
    setError("");
    const result = await command<RecordValue>("company.export", { ventureId: selected });
    setBusy("");
    if (!result.ok || !result.data) { setError(result.error?.message ?? "Company export failed."); return; }
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(result.data, null, 2)}\n`], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${current.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "company"}-export.json`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice("Company export downloaded.");
  }

  async function deleteCompany() {
    if (!selected || !current) return;
    const confirmation = window.prompt(`Permanently delete ${current.name}? Type this company ID to continue:\n\n${selected}`);
    if (confirmation !== selected) return;
    setBusy("company.delete");
    setError("");
    const result = await command("company.delete", {
      ventureId: selected,
      confirmVentureId: selected,
      actor: "founder",
      requestedAt: now(),
      idempotencyKey: key("cloud-delete")
    });
    setBusy("");
    if (!result.ok) { setError(result.error?.message ?? "Company deletion failed."); return; }
    setNotice("Company and its scoped runtime data were deleted.");
    setSelected(null);
    setDetail(null);
    await refresh(null);
  }

  function chooseCompany(ventureId: string) {
    setSelected(ventureId);
    setDetail(null);
    void refresh(ventureId);
  }

  async function signOut() {
    setSigningOut(true);
    const result = await auth("sign-out", {});
    setSigningOut(false);
    if (!result.ok) { setError(authError(result)); return; }
    onSignOut();
  }

  async function resolveApproval(approval: Approval, decision: "approve" | "deny") {
    if (!selected) return;
    setBusy(`approval:${approval.id}:${decision}`);
    setError("");
    setNotice("");
    const result = await command("approval.resolve", {
      ventureId: selected,
      approvalId: approval.id,
      expectedActionDigest: approval.actionDigest,
      decision,
      actor: "founder",
      resolvedAt: now(),
      idempotencyKey: key(`cloud-approval-${decision}`)
    });
    setBusy("");
    if (!result.ok) { setError(result.error?.message ?? `The approval could not be ${decision === "approve" ? "approved" : "denied"}.`); return; }
    setNotice(decision === "approve" ? "Exact action approved. The runtime will re-check the saved scope before continuing." : "Exact action denied. The gated branch will not proceed.");
    await refresh(selected);
  }

  if (loading && companies.length === 0) return <main className="cloud-shell"><p className="state">Loading your portfolio…</p></main>;
  if (error && companies.length === 0) return <main className="cloud-shell"><section className="state"><h1>Cloud is unavailable</h1><p>{error}</p><button onClick={() => void refresh()}>Try again</button></section></main>;

  return <main className="cloud-shell">
    <aside className="portfolio" aria-label="Portfolio">
      <a className="brand" href="#main">OpSpot <span>GTM Cloud</span></a>
      <p className="eyebrow">Portfolio</p>
      <div className="company-list">
        {companies.map((company) => <button className={company.ventureId === selected ? "company-switch selected" : "company-switch"} key={company.ventureId} onClick={() => chooseCompany(company.ventureId)} aria-pressed={company.ventureId === selected}>
          <strong>{company.name}</strong><small>{label(company.state.runState)} · {label(company.state.lifecycleState)}</small>
        </button>)}
      </div>
      <a href="#new-company" className="new-link">+ New company</a>
      <div className="account"><span>{user.email}</span>{!user.local && <button onClick={() => void signOut()} disabled={signingOut}>{signingOut ? "Signing out…" : "Log out"}</button>}</div>
    </aside>

    <div className="main" id="main">
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {current && state && <>
        <header className="cockpit-header">
          <div><p className="eyebrow">Company cockpit</p><h1>{current.name}</h1><p className="summary">Destination: <strong>{label(state.bootstrap?.snapshot?.destination)}</strong> · {state.bootstrap?.snapshot?.horizonDays ?? "—"} day horizon</p></div>
          <div className="controls">
            <button className="primary" onClick={() => void control("company.run")} disabled={busy !== "" || state.runState === "killed"}> {busy === "company.run" ? "Starting…" : "Run"} </button>
            <button onClick={() => void control("company.pause")} disabled={busy !== "" || state.runState !== "running"}>Pause</button>
            <button onClick={() => void billing(canManageBilling ? "portal" : "checkout")} disabled={busy !== ""}>{busy.startsWith("billing:") ? "Opening billing…" : canManageBilling ? "Manage billing" : "Start subscription"}</button>
            <button onClick={() => void exportCompany()} disabled={busy !== ""}>{busy === "company.export" ? "Exporting…" : "Export"}</button>
            <button className="danger" onClick={() => void control("company.kill")} disabled={busy !== "" || state.runState === "killed"}>Kill</button>
            <button className="danger" onClick={() => void deleteCompany()} disabled={busy !== ""}>{busy === "company.delete" ? "Deleting…" : "Delete"}</button>
          </div>
        </header>

        <section className="grid" aria-label="Company status">
          <article><p className="eyebrow">Lifecycle</p><h2>{label(state.lifecycleState)}</h2><p>Runtime: <strong>{label(state.runState)}</strong></p></article>
          <article><p className="eyebrow">Proof</p><h2>{detail?.evidence?.length ?? 0} evidence items</h2><p>{detail?.receipts?.length ?? 0} receipts. Open the safe detail below for tier and authority.</p></article>
          <article><p className="eyebrow">Money</p><h2>{label(entitlement?.status ?? "unentitled")}</h2><p>{entitlement?.plan ?? "No plan"} · {money(entitlement?.spentCostCents)} of {money(entitlement?.modelCostCapCents)} model cap{entitlement?.periodEnd ? ` · ends ${dateTime(entitlement.periodEnd)}` : ""}</p></article>
          <article><p className="eyebrow">Approvals</p><h2>{pendingApprovals.length ? `${pendingApprovals.length} pending` : "None pending"}</h2><p>{pendingApprovals.length ? "Review each exact action below." : "New exceptions will appear here."}</p></article>
        </section>

        <section className="runtime-status" aria-labelledby="runtime-title"><p className="eyebrow">Autonomy</p><h2 id="runtime-title">{label(state.runState)}</h2><p>{runtimeStatus}</p></section>

        <section className="readiness" aria-labelledby="readiness-title">
          <p className="eyebrow">Lifecycle proof</p><h2 id="readiness-title">What is proven, uncertain, and missing</h2>
          <div className="readiness-grid">
            <article className="proof-green"><h3>Proven green</h3><p>{externalEvidence.length ? `${externalEvidence.length} current external or authoritative outcome${externalEvidence.length === 1 ? "" : "s"}.` : "No external, revenue, or fulfillment outcome is proven yet."}</p></article>
            <article className="proof-amber"><h3>Uncertain amber</h3><p>{internalEvidence.length ? `${internalEvidence.length} internal evidence item${internalEvidence.length === 1 ? "" : "s"} still require market or provider confirmation.` : "The company has not produced an internal evidence artifact yet."}</p></article>
            <article className="proof-red"><h3>Missing red</h3><p>{unknowns.length ? unknowns.slice(0, 3).join(" · ") : "No named readiness gap is currently recorded."}</p></article>
          </div>
        </section>

        <details className="proof-details"><summary>Proof details</summary><p>Only proof tier, status, type, outcome, and authority are shown here. Internal paths, IDs, credentials, and raw receipts stay out of the founder view.</p><div className="proof-detail-grid">{[...(detail?.evidence ?? []).map((item) => ({ label: item.type ?? "Evidence", value: `${label(item.proofTier)} · ${label(item.status)} · ${label(item.authority)}` })), ...(detail?.receipts ?? []).map((item) => ({ label: "Receipt", value: `${label(item.proofTier)} · ${label(item.outcome)}` }))].map((item, index) => <p key={`${item.label}-${index}`}><strong>{item.label}:</strong> {item.value}</p>)}</div></details>

        <section className="initiative">
          <p className="eyebrow">Current initiative</p><h2>{state.currentInitiative?.title ?? "No initiative is selected"}</h2>
          <p>{state.currentInitiative?.uncertaintyReason ?? "Run the company to let the CEO loop observe, decide, and create bounded work."}</p>
          <dl>
            <div><dt>Agents will</dt><dd>{state.currentInitiative?.expectedOutcome ?? "Observe current truth and propose bounded work."}</dd></div>
            <div><dt>You must</dt><dd>{pendingApprovals.length ? `Review ${pendingApprovals.length} exact exception${pendingApprovals.length === 1 ? "" : "s"} below.` : "Nothing unless an exact exception or account connection appears."}</dd></div>
            <div><dt>Proof that advances</dt><dd>{state.currentInitiative?.expectedProof ?? "Not recorded"}</dd></div>
            <div><dt>Capability</dt><dd>{label(state.currentInitiative?.capabilityId)}</dd></div>
          </dl>
        </section>

        {pendingApprovals.length ? <section className="approvals" aria-labelledby="approvals-title">
          <p className="eyebrow">Founder exceptions</p><h2 id="approvals-title">Exact approval required</h2>
          <p>Only the actions below are gated. The company status and pre-authorized safe work remain visible above.</p>
          <div className="approval-list">
            {pendingApprovals.map((approval) => <article className="approval-card" key={approval.id} aria-labelledby={`approval-${approval.id}`}>
              <header><h3 id={`approval-${approval.id}`}>{approval.packet.recommendedAction}</h3><span>{label(approval.status)}</span></header>
              <dl>
                <div><dt>Target</dt><dd>{approval.packet.target}</dd></div>
                <div><dt>Cap or cost</dt><dd>{approval.packet.capOrCost}</dd></div>
                <div><dt>Sender or system</dt><dd>{approval.packet.senderOrSystem}</dd></div>
                <div><dt>Expires</dt><dd><time dateTime={approval.packet.expiresAt || approval.expiresAt}>{dateTime(approval.packet.expiresAt || approval.expiresAt)}</time></dd></div>
                <div><dt>Rollback or kill route</dt><dd>{approval.packet.rollbackOrKillRoute}</dd></div>
                {approval.packet.exactCommandOrProviderCall && <div><dt>Exact execution</dt><dd>{approval.packet.exactCommandOrProviderCall}</dd></div>}
              </dl>
              <div className="approval-actions">
                <button className="primary" onClick={() => void resolveApproval(approval, "approve")} disabled={busy !== ""}>{busy === `approval:${approval.id}:approve` ? "Approving…" : "Approve"}</button>
                <button className="danger" onClick={() => void resolveApproval(approval, "deny")} disabled={busy !== ""}>{busy === `approval:${approval.id}:deny` ? "Denying…" : "Deny"}</button>
              </div>
            </article>)}
          </div>
        </section> : null}

        {detail?.failedJobs?.length ? <section className="approvals" aria-labelledby="failed-jobs-title">
          <p className="eyebrow">Runtime attention</p><h2 id="failed-jobs-title">Failed work</h2>
          <p>Provider errors are redacted. Inspect the bounded job and retry only after its external-effect state is reconciled.</p>
          <div className="approval-list">
            {detail.failedJobs.map((job) => <article className="approval-card" key={job.id}>
              <header><h3>{label(job.kind)}</h3><span>{label(job.status)}</span></header>
              <p>{job.attemptCount} attempt{job.attemptCount === 1 ? "" : "s"} · updated <time dateTime={job.updatedAt}>{dateTime(job.updatedAt)}</time>{job.error ? " · provider detail redacted" : ""}</p>
            </article>)}
          </div>
        </section> : null}
      </>}

      <section className="onboarding" id="new-company" aria-labelledby="new-company-title">
        <div><p className="eyebrow">Start a company</p><h2 id="new-company-title">Tell the runtime what you are building.</h2><p>It will create a bounded company record, initial initiative, trial budget, and safe default permissions. It will not send, publish, spend, or change credentials without an exact approval.</p></div>
        <form onSubmit={createCompany}>
          <label>Company name <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Optional until validated" maxLength={240} /></label>
          <label>Idea or existing offer <textarea value={form.idea} onChange={(event) => setForm({ ...form, idea: event.target.value })} minLength={20} required placeholder="Describe the customer, problem, and offer in plain language." /></label>
          <div className="form-grid"><label>Owner <input value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} required /></label><label>Destination <select value={form.destination} onChange={(event) => setForm({ ...form, destination: event.target.value })}>{destinations.map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label><label>Horizon (days) <input type="number" min="1" max="3650" value={form.horizonDays} onChange={(event) => setForm({ ...form, horizonDays: event.target.value })} required /></label><label>Initial model budget (USD) <input type="number" min="0" max="1000000" step="0.01" value={form.budget} onChange={(event) => setForm({ ...form, budget: event.target.value })} required /></label></div>
          <fieldset>
            <legend>Optional owned email self-test</legend>
            <p>Leave blank for research-only autonomy. A configured sender and recipient still remain disabled until the provider proves sender ownership, recipient ownership, suppression, and caps.</p>
            <div className="form-grid"><label>Verified sender <input type="email" autoComplete="email" value={form.senderIdentity} onChange={(event) => setForm({ ...form, senderIdentity: event.target.value })} placeholder="name@example.invalid" aria-invalid={Boolean(form.senderIdentity.trim()) !== Boolean(form.ownedRecipient.trim())} /></label><label>Inbox you own <input type="email" autoComplete="email" value={form.ownedRecipient} onChange={(event) => setForm({ ...form, ownedRecipient: event.target.value })} placeholder="name@example.invalid" aria-invalid={Boolean(form.senderIdentity.trim()) !== Boolean(form.ownedRecipient.trim())} /></label><label>Daily send cap <input type="number" min="1" max="20" value={form.dailyActionCap} onChange={(event) => setForm({ ...form, dailyActionCap: event.target.value })} /></label><label>Weekly send cap <input type="number" min="1" max="100" value={form.weeklyActionCap} onChange={(event) => setForm({ ...form, weeklyActionCap: event.target.value })} /></label></div>
          </fieldset>
          <label>Permission boundary <textarea value={form.permissions} onChange={(event) => setForm({ ...form, permissions: event.target.value })} required /></label>
          <p className="publication-boundary"><strong>Publication is disabled.</strong> A public offer, post, or deployment needs immutable preauthorization or one exact approval; this form cannot grant it.</p>
          <button className="primary" disabled={busy === "create"}>{busy === "create" ? "Creating…" : "Create company"}</button>
        </form>
      </section>
    </div>
  </main>;
}
