import * as fs from "node:fs/promises";
import { watch } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

type Limit = { utilization?: number; resets_at?: string };
type UsageResponse = {
  five_hour?: Limit;
  seven_day?: Limit;
  seven_day_opus?: Limit;
  extra_usage?: { is_enabled?: boolean; used_credits?: number; monthly_limit?: number };
  monthly?: Limit;
  month?: Limit;
  spend?: { used?: number; limit?: number; percent?: number; currency?: string };
  [key: string]: unknown;
};

type Snapshot = { recordedAt: string; fiveHour?: number; sevenDay?: number; monthly?: number };
type Cost = { current: number; session: number; sessionId?: string; model?: string };
type UsageCache = { fetchedAt: string; usage: UsageResponse };

const cachePath = path.join(os.homedir(), ".claude", "enterprise-usage-history.json");
const latestUsagePath = path.join(os.homedir(), ".claude", "enterprise-usage-cache.json");
const projectsPath = path.join(os.homedir(), ".claude", "projects");
const REMOTE_REFRESH_MS = 15 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;

export function activate(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  item.command = "claudeEnterpriseUsage.showDetails";
  context.subscriptions.push(item);

  let latest: UsageResponse | undefined;
  let cost: Cost | undefined;
  let nextUsageFetchAt = 0;
  let usageStatus: string | undefined;
  const refresh = async (quiet = false, allowRemote = true) => {
    // This is fast and entirely local: it is safe to run once per Claude response.
    try {
      cost = await getLatestSessionCost(activeClaudeTabLabel());
    } catch (error) {
      usageStatus = `Could not read local Claude Code log: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!latest) {
      const cached = await readUsageCache();
      if (cached) {
        latest = cached.usage;
        nextUsageFetchAt = Math.max(nextUsageFetchAt, new Date(cached.fetchedAt).getTime() + REMOTE_REFRESH_MS);
      }
    }
    if (allowRemote && Date.now() >= nextUsageFetchAt) {
      try {
        latest = await fetchUsage();
        nextUsageFetchAt = Date.now() + REMOTE_REFRESH_MS;
        usageStatus = undefined;
        await writeUsageCache(latest);
        await appendSnapshot(latest);
      } catch (error) {
        const retryAfter = error instanceof UsageRequestError ? error.retryAfterMs : undefined;
        nextUsageFetchAt = Date.now() + (retryAfter ?? RATE_LIMIT_BACKOFF_MS);
        usageStatus = error instanceof Error ? error.message : String(error);
        // Preserve the last successful MTD response instead of replacing it with an error.
        if (!quiet && !latest) vscode.window.showWarningMessage(`Claude usage refresh deferred: ${usageStatus}`);
      }
    }
    render(item, latest ?? {}, cost, usageStatus, nextUsageFetchAt);
    item.show();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeEnterpriseUsage.refresh", () => refresh()),
    vscode.commands.registerCommand("claudeEnterpriseUsage.showDetails", async () => showDetails(latest, cost)),
  );

  void refresh(true);
  const seconds = vscode.workspace.getConfiguration("claudeEnterpriseUsage").get<number>("refreshIntervalSeconds", 900);
  context.subscriptions.push(new vscode.Disposable(() => item.dispose()));
  const timer = setInterval(() => void refresh(true), Math.max(seconds, 60) * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Claude editor tabs expose their generated conversation title. Match that
  // title to the `ai-title` record in the local JSONL transcript whenever the
  // user switches tabs.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => void refresh(true, false)),
    vscode.window.tabGroups.onDidChangeTabGroups(() => void refresh(true, false)),
  );

  // Claude Code appends an assistant record after every model response. Update only
  // local token estimates here: the API-backed MTD is intentionally rate-limited.
  try {
    let debounce: NodeJS.Timeout | undefined;
    const watcher = watch(projectsPath, { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(true, false), 900);
    });
    context.subscriptions.push({ dispose: () => { clearTimeout(debounce); watcher.close(); } });
  } catch { /* The extension still works where recursive filesystem watch is unavailable. */ }
}

class UsageRequestError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) { super(message); }
}
async function fetchUsage(): Promise<UsageResponse> {
  const token = await readClaudeToken();
  const response = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } });
  if (response.status === 401) throw new UsageRequestError("Claude Code login has expired. Run `claude /login`.");
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new UsageRequestError("Anthropic rate-limited the monthly-usage request; showing cached data.", Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
  }
  if (!response.ok) throw new UsageRequestError(`Anthropic returned HTTP ${response.status}.`);
  return await response.json() as UsageResponse;
}

async function readClaudeToken(): Promise<string> {
  const credentialPath = path.join(os.homedir(), ".claude", ".credentials.json");
  try {
    const parsed = JSON.parse(await fs.readFile(credentialPath, "utf8")) as { claudeAiOauth?: { accessToken?: string } };
    const token = parsed.claudeAiOauth?.accessToken;
    if (token) return token;
  } catch { /* macOS normally stores this in Keychain. */ }

  if (process.platform === "darwin") {
    const { execFile } = await import("node:child_process");
    const token = await new Promise<string>((resolve, reject) => {
      execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], (error, stdout) =>
        error ? reject(error) : resolve(stdout.trim()));
    });
    const parsed = JSON.parse(token) as { claudeAiOauth?: { accessToken?: string } };
    if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth.accessToken;
  }
  throw new Error("No Claude Code OAuth credential found.");
}

function render(item: vscode.StatusBarItem, usage: UsageResponse, cost?: Cost, status?: string, nextUsageFetchAt?: number): void {
  const month = usage.spend?.percent ?? percentUsed(usage.monthly ?? usage.month);
  const spendLabel = formatSpend(usage.spend);
  const mtd = spendLabel ? `Monthly ${spendLabel}` : (month !== undefined ? `Monthly ${month}%` : "Monthly –");
  item.text = `$(pulse) Claude ${cost ? `Current ${usd(cost.current)} · Session ${usd(cost.session)} · ` : ""}${mtd}`;
  item.tooltip = [
    "Claude Enterprise Usage",
    spendLabel ? `Monthly Enterprise spend: ${spendLabel}` : (month !== undefined ? `Monthly usage: ${month}% used${resetText(usage.monthly ?? usage.month)}` : "Monthly field unavailable from Claude Code; open Claude member Usage for the source of truth."),
    cost ? `Current chat turn: ~${usd(cost.current)} · current session: ~${usd(cost.session)} (${cost.model ?? "unknown model"})` : undefined,
    "Current/session costs deduplicate model request IDs and use local Claude Code token logs. Monthly is the server-reported Enterprise amount.",
    status ? `${status}${nextUsageFetchAt ? ` Next monthly refresh after ${new Date(nextUsageFetchAt).toLocaleTimeString()}.` : ""}` : undefined,
    "Click for details · Command Palette: Claude Enterprise Usage: Refresh"
  ].filter(Boolean).join("\n");
}

function percentUsed(limit?: Limit): number | undefined {
  // The OAuth endpoint returns a percentage (for example 27.5), not a 0–1 ratio.
  return typeof limit?.utilization === "number" ? Math.round(limit.utilization) : undefined;
}
function resetText(limit?: Limit): string { return limit?.resets_at ? ` · resets ${new Date(limit.resets_at).toLocaleString()}` : ""; }
function formatSpend(spend?: UsageResponse["spend"]): string | undefined {
  if (!spend || typeof spend.used !== "number" || typeof spend.limit !== "number") return undefined;
  const currency = spend.currency ?? "USD";
  // Enterprise's OAuth response reports amounts in minor currency units.
  const used = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(spend.used / 100);
  const limit = new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 0 }).format(spend.limit / 100);
  return `${spend.percent ?? Math.round(spend.used / spend.limit * 100)}% · ${used}/${limit}`;
}
function usd(value: number): string { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value); }

async function showDetails(usage?: UsageResponse, cost?: Cost): Promise<void> {
  const history = await readHistory();
  const month = usage?.spend?.percent ?? percentUsed(usage?.monthly ?? usage?.month);
  const spendLabel = formatSpend(usage?.spend);
  const lines = [
    `# Claude Enterprise Usage`,
    spendLabel ? `**Monthly Enterprise spend:** ${spendLabel}` : (month !== undefined ? `**Monthly usage:** ${month}% used` : "**Monthly usage:** not returned by the Claude Code usage endpoint."),
    cost ? `**Current chat turn estimate:** ${usd(cost.current)}\n\n**Current session estimate:** ${usd(cost.session)} (${cost.model ?? "unknown model"})` : "**Current turn/session cost:** no Claude Code log found.",
    "",
    `Local snapshots this month: ${history.filter(s => s.recordedAt.startsWith(new Date().toISOString().slice(0, 7))).length}`,
    "",
    "[Open Claude member Usage](https://claude.ai/new#settings/usage)"
  ];
  const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function activeClaudeTabLabel(): string | undefined {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  if (!tab || !(tab.input instanceof vscode.TabInputWebview) || !tab.input.viewType.includes("claudeVSCodePanel")) return undefined;
  return tab.label;
}

async function getLatestSessionCost(activeTabLabel?: string): Promise<Cost | undefined> {
  let paths: string[];
  try { paths = (await fs.readdir(projectsPath, { recursive: true })).filter(p => p.endsWith(".jsonl")); } catch { return undefined; }
  const candidates = await Promise.all(paths.map(async relative => {
    const absolute = path.join(projectsPath, relative);
    try { return { absolute, mtime: (await fs.stat(absolute)).mtimeMs }; } catch { return undefined; }
  }));
  const sorted = candidates.filter((x): x is { absolute: string; mtime: number } => Boolean(x)).sort((a, b) => b.mtime - a.mtime);
  let selected = sorted[0];
  if (activeTabLabel && activeTabLabel !== "Claude Code") {
    const match = await findTranscriptForTab(sorted, activeTabLabel);
    if (match) selected = match;
  }
  if (!selected) return undefined;
  const records = parseLogRecords(await fs.readFile(selected.absolute, "utf8"));
  const assistant = deduplicateRequests(records.filter(record => record.type === "assistant" && record.message?.usage));
  const last = assistant.at(-1);
  if (!last?.message?.usage) return undefined;
  const sessionId = last.sessionId;
  const inSession = assistant.filter(record => record.sessionId === sessionId);
  const latestHumanIndex = findLatestHumanPromptIndex(records, sessionId);
  const currentRequests = deduplicateRequests(records.slice(latestHumanIndex + 1).filter(record => record.type === "assistant" && record.message?.usage && record.sessionId === sessionId));
  return {
    current: currentRequests.reduce((total, record) => total + estimateCost(record.message?.model, record.message?.usage), 0),
    session: inSession.reduce((total, record) => total + estimateCost(record.message?.model, record.message?.usage), 0),
    sessionId,
    model: last.message.model
  };
}

async function findTranscriptForTab(candidates: Array<{ absolute: string; mtime: number }>, label: string): Promise<{ absolute: string; mtime: number } | undefined> {
  const prefix = normalizeTabTitle(label);
  if (!prefix) return undefined;
  // Open tabs are overwhelmingly recent. Bounding this scan prevents old or
  // very large Claude histories from slowing down a tab switch.
  for (const candidate of candidates.slice(0, 100)) {
    try {
      const handle = await fs.open(candidate.absolute, "r");
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const title = parseLogRecords(buffer.subarray(0, bytesRead).toString("utf8")).find(record => record.type === "ai-title")?.aiTitle;
        if (title && normalizeTabTitle(title).startsWith(prefix)) return candidate;
      } finally { await handle.close(); }
    } catch { /* Ignore transcripts concurrently rotated or removed by Claude. */ }
  }
  return undefined;
}

function normalizeTabTitle(title: string): string {
  return title.trim().replace(/[.…]+$/u, "").trim().toLocaleLowerCase();
}

function parseLogRecords(content: string): LogRecord[] {
  return content.split("\n").flatMap(line => { try { return [JSON.parse(line) as LogRecord]; } catch { return []; } });
}

type TokenUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } };
type LogRecord = { type?: string; aiTitle?: string; uuid?: string; requestId?: string; sessionId?: string; message?: { model?: string; usage?: TokenUsage; content?: unknown } };
function deduplicateRequests(records: LogRecord[]): LogRecord[] {
  const byRequest = new Map<string, LogRecord>();
  records.forEach((record, index) => {
    const key = record.requestId || record.uuid || `record-${index}`;
    const previous = byRequest.get(key);
    // Duplicate stream records normally contain identical cumulative usage. If
    // they differ, keep the largest/final usage record for that API request.
    if (!previous || estimateCost(record.message?.model, record.message?.usage) >= estimateCost(previous.message?.model, previous.message?.usage)) byRequest.set(key, record);
  });
  return [...byRequest.values()];
}
function findLatestHumanPromptIndex(records: LogRecord[], sessionId?: string): number {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.type !== "user" || record.sessionId !== sessionId) continue;
    const content = record.message?.content;
    if (typeof content === "string" && !content.startsWith("<local-command-")) return index;
    if (Array.isArray(content) && content.some(block => isHumanTextBlock(block))) return index;
  }
  return -1;
}
function isHumanTextBlock(block: unknown): boolean {
  return Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text" && !(block as { text?: string }).text?.startsWith("<local-command-"));
}
function estimateCost(model: string | undefined, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  const name = model?.toLowerCase() ?? "";
  // Standard API rates per million tokens. Enterprise negotiated pricing may differ.
  const base = name.includes("opus") ? [5, 25] : name.includes("haiku") ? [1, 5] : name.includes("sonnet-5") ? [2, 10] : [3, 15];
  const input = (usage.input_tokens ?? 0) * base[0] / 1_000_000;
  const output = (usage.output_tokens ?? 0) * base[1] / 1_000_000;
  const read = (usage.cache_read_input_tokens ?? 0) * base[0] * 0.1 / 1_000_000;
  const hasCacheBreakdown = usage.cache_creation !== undefined;
  const oneHour = (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) * base[0] * 2 / 1_000_000;
  const fiveMinuteTokens = hasCacheBreakdown
    ? (usage.cache_creation?.ephemeral_5m_input_tokens ?? 0)
    : (usage.cache_creation_input_tokens ?? 0);
  const fiveMinutes = fiveMinuteTokens * base[0] * 1.25 / 1_000_000;
  return input + output + read + oneHour + fiveMinutes;
}

async function appendSnapshot(usage: UsageResponse): Promise<void> {
  const history = await readHistory();
  history.push({ recordedAt: new Date().toISOString(), fiveHour: percentUsed(usage.five_hour), sevenDay: percentUsed(usage.seven_day), monthly: percentUsed(usage.monthly ?? usage.month) });
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(history.slice(-1000), null, 2), { mode: 0o600 });
}
async function readHistory(): Promise<Snapshot[]> {
  try { return JSON.parse(await fs.readFile(cachePath, "utf8")) as Snapshot[]; } catch { return []; }
}
async function writeUsageCache(usage: UsageResponse): Promise<void> {
  await fs.mkdir(path.dirname(latestUsagePath), { recursive: true });
  await fs.writeFile(latestUsagePath, JSON.stringify({ fetchedAt: new Date().toISOString(), usage }, null, 2), { mode: 0o600 });
}
async function readUsageCache(): Promise<UsageCache | undefined> {
  try { return JSON.parse(await fs.readFile(latestUsagePath, "utf8")) as UsageCache; } catch { return undefined; }
}
