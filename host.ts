import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  BRIDGE_JSON_RPC_ERRORS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  bridgeRequestEnvelopeSchema,
  createBridgeIo,
  createBridgeLineHandler,
  experimental_defineProviderBridge,
  experimental_resolveExecutablePath,
  type ProviderUsageResult,
} from "@get-bb/plugin-sdk/provider-bridge";

const TIMEOUT_MS = 20_000;

export interface ParsedQuota { label: string; used: number; limit: number }

// Confirmed by GitHub's authenticated AI usage page. GitHub does not expose
// this date in the Copilot CLI's /usage output, so advance the account's
// monthly billing anniversary without copying browser cookies into BB.
const BILLING_CYCLE_DAY = 30;

export function nextBillingReset(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const candidate = resetInMonth(year, month);
  return (candidate.getTime() > now.getTime() ? candidate : resetInMonth(year, month + 1)).toISOString();
}

export function quotaReset(resetDate: string | undefined, now = new Date()): string {
  const parsed = resetDate ? Date.parse(resetDate) : Number.NaN;
  // Some CLI releases populate resetDate with the quota fetch timestamp. Only
  // trust a plausible future reset; otherwise retain the known billing cycle.
  if (Number.isFinite(parsed) && parsed > now.getTime() + 6 * 60 * 60 * 1_000
    && parsed < now.getTime() + 45 * 24 * 60 * 60 * 1_000) {
    return new Date(parsed).toISOString();
  }
  return nextBillingReset(now);
}

function resetInMonth(year: number, month: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(BILLING_CYCLE_DAY, lastDay)));
}

export function parseCopilotQuota(output: string): ParsedQuota | null {
  const aic = [...output.matchAll(/([\d,]+)\s*\/\s*([\d,]+)\s*AIC\b/giu)].at(-1);
  if (aic) return { label: "AI credits", used: number(aic[1]), limit: number(aic[2]) };
  const requests = [...output.matchAll(/([\d,]+)\s*\/\s*([\d,]+)\s*(?:premium\s+)?requests?\b/giu)].at(-1);
  return requests ? { label: "Premium requests", used: number(requests[1]), limit: number(requests[2]) } : null;
}

function errorResult(message: string): ProviderUsageResult {
  return { supported: true, usage: { status: "error", message, accountEmail: null, planLabel: null } };
}

function number(value: string): number { return Number(value.replaceAll(",", "")); }

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args, { timeout: 5_000, encoding: "utf8" });
  return stdout;
}

async function windowsCopilotExecutable(executable: string): Promise<string> {
  if (!new Set([".cmd", ".ps1"]).has(extname(executable).toLowerCase())) return executable;
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const native = join(
    dirname(executable),
    "node_modules",
    "@github",
    "copilot",
    "node_modules",
    "@github",
    `copilot-win32-${architecture}`,
    "copilot.exe",
  );
  try {
    await access(native);
    return native;
  } catch {
    return executable;
  }
}

async function resolveCopilotExecutable(): Promise<string | null> {
  const resolved = await experimental_resolveExecutablePath("copilot");
  if (resolved) return process.platform === "win32" ? windowsCopilotExecutable(resolved) : resolved;
  if (process.platform !== "win32") return null;
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const directory of pathValue.split(";").filter(Boolean)) {
    for (const filename of ["copilot.exe", "copilot.cmd", "copilot.bat", "copilot.ps1"]) {
      const candidate = join(directory.replace(/^"|"$/gu, ""), filename);
      try {
        await access(candidate);
        return windowsCopilotExecutable(candidate);
      } catch {}
    }
  }
  return null;
}

interface AccountQuotaSnapshot {
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  resetDate?: string;
}

export function resultFromSnapshots(
  snapshots: Record<string, AccountQuotaSnapshot | undefined>,
): ProviderUsageResult {
  const preferred = snapshots.premium_interactions;
  const entry = preferred
    ? ["premium_interactions", preferred] as const
    : Object.entries(snapshots).find(([, snapshot]) =>
      snapshot && snapshot.entitlementRequests > 0 && Number.isFinite(snapshot.remainingPercentage));
  if (!entry) return errorResult("Copilot did not return a finite account quota.");
  const [kind, quota] = entry;
  if (!quota) return errorResult("Copilot returned an invalid account quota.");
  const usedPercent = Number.isFinite(quota.remainingPercentage)
    ? 100 - quota.remainingPercentage
    : quota.usedRequests / quota.entitlementRequests * 100;
  return { supported: true, usage: {
    status: "ok",
    accountEmail: null,
    planLabel: "GitHub Copilot",
    windows: [{
      label: kind === "premium_interactions" ? "Premium requests" : kind.replaceAll("_", " "),
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      resetsAt: quotaReset(quota.resetDate),
    }],
  } };
}

async function readUsageWithSdk(executable: string): Promise<ProviderUsageResult> {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: await windowsCopilotExecutable(executable) }),
    workingDirectory: homedir(),
    logLevel: "none",
    useLoggedInUser: true,
  });
  try {
    await client.start();
    const quota = await client.rpc.account.getQuota({});
    return resultFromSnapshots(quota.quotaSnapshots);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b(?:auth(?:entication|enticated)?|unauthenticated|credential|log\s*in|login|token)\b/iu.test(message)) {
      return { supported: true, usage: { status: "unauthenticated" } };
    }
    return errorResult(message);
  } finally {
    try { await client.stop(); } catch {}
  }
}

function result(quota: ParsedQuota): ProviderUsageResult {
  if (!(quota.limit > 0) || !Number.isFinite(quota.used)) {
    return errorResult("Copilot returned an invalid quota.");
  }
  return { supported: true, usage: { status: "ok", accountEmail: null, planLabel: "GitHub Copilot", windows: [{
    label: quota.label,
    usedPercent: Math.max(0, Math.min(100, quota.used / quota.limit * 100)),
    resetsAt: nextBillingReset(),
  }] } };
}

async function readUsage(): Promise<ProviderUsageResult> {
  const executable = await resolveCopilotExecutable();
  if (!executable) return { supported: true, usage: { status: "not_installed" } };
  if (process.platform === "win32") {
    return readUsageWithSdk(executable);
  }
  // Copilot's TUI asks the terminal for capability/color responses before it
  // renders. node-pty alone does not emulate those replies, whereas tmux does.
  // Run a short-lived private tmux session, open /usage, and capture its pane.
  const session = `bb-copilot-usage-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    const command = `${shellQuote(executable)} --no-color --no-auto-update`;
    await tmux(["new-session", "-d", "-s", session, "-c", homedir(), command]);
    started = true;
    const began = Date.now();
    let acceptedTrust = false;
    let usageRequested = false;
    let output = "";
    while (Date.now() - began < TIMEOUT_MS) {
      const elapsed = Date.now() - began;
      // Every new Copilot session asks once for folder trust. The default option
      // is "Yes"; accepting it is required before slash commands are accepted.
      if (!acceptedTrust && elapsed >= 2_500) {
        await tmux(["send-keys", "-t", `${session}:0`, "Enter"]);
        acceptedTrust = true;
      }
      if (!usageRequested && elapsed >= 5_500) {
        await tmux(["send-keys", "-t", `${session}:0`, "/usage", "Enter"]);
        usageRequested = true;
      }
      output = await tmux(["capture-pane", "-p", "-e", "-t", `${session}:0`, "-S", "-200"]);
      const quota = parseCopilotQuota(output);
      if (quota) return result(quota);
      if (output.toLowerCase().includes("login")) {
        return { supported: true, usage: { status: "unauthenticated" } };
      }
      await sleep(750);
    }
    return errorResult("Timed out while reading Copilot usage.");
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    if (started) {
      try { await tmux(["send-keys", "-t", `${session}:0`, "/exit", "Enter"]); } catch {}
      try { await tmux(["kill-session", "-t", session]); } catch {}
    }
  }
}

const io = createBridgeIo();
const handleLine = createBridgeLineHandler({ handleParsedMessage(message) {
  const parsed = bridgeRequestEnvelopeSchema.safeParse(message);
  if (!parsed.success) return;
  const request = parsed.data;
  if (request.method === "initialize") {
    io.sendResult(request.id, { ok: true, protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: {
      sessionRestore: false, threadArchive: false, threadRename: false, threadGoalClear: false,
      fork: "none", approvalEnforcedBy: "runtime", grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      steerMode: "queue", skills: { configure: false },
    } });
  } else if (request.method === "provider/usage") {
    void readUsage().then((usage) => io.sendResult(request.id, usage));
  } else if (request.method === "model/list") {
    io.sendResult(request.id, { models: [], selectedOnlyModels: [] });
  } else {
    io.sendError(request.id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method "${request.method}"`);
  }
} });

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  onClose: () => process.exit(0),
  onSigterm: () => process.exit(0),
  onSigint: () => process.exit(0),
});

