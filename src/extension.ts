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
type Cost = { last: number; session: number; sessionId?: string; model?: string };

const cachePath = path.join(os.homedir(), ".claude", "enterprise-usage-history.json");
const projectsPath = path.join(os.homedir(), ".claude", "projects");

export function activate(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20);
  item.command = "claudeEnterpriseUsage.showDetails";
  context.subscriptions.push(item);

  let latest: UsageResponse | undefined;
  let cost: Cost | undefined;
  const refresh = async (quiet = false) => {
    try {
      cost = await getLatestSessionCost();
      latest = await fetchUsage();
      render(item, latest, cost);
      await appendSnapshot(latest);
    } catch (error) {
      item.text = "$(warning) Claude usage unavailable";
      item.tooltip = `Claude Enterprise Usage\n${error instanceof Error ? error.message : String(error)}`;
      if (!quiet) vscode.window.showWarningMessage("Could not refresh Claude usage. Run Claude Code /login, then try again.");
    }
    item.show();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeEnterpriseUsage.refresh", () => refresh()),
    vscode.commands.registerCommand("claudeEnterpriseUsage.showDetails", async () => showDetails(latest, cost)),
  );

  void refresh(true);
  const seconds = vscode.workspace.getConfiguration("claudeEnterpriseUsage").get<number>("refreshIntervalSeconds", 300);
  context.subscriptions.push(new vscode.Disposable(() => item.dispose()));
  const timer = setInterval(() => void refresh(true), Math.max(seconds, 60) * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Claude Code appends an assistant record after every model response. Update the
  // token-derived request/session estimates immediately; refresh the API-backed MTD too.
  try {
    let debounce: NodeJS.Timeout | undefined;
    const watcher = watch(projectsPath, { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(true), 900);
    });
    context.subscriptions.push({ dispose: () => { clearTimeout(debounce); watcher.close(); } });
  } catch { /* The extension still works where recursive filesystem watch is unavailable. */ }
}

async function fetchUsage(): Promise<UsageResponse> {
  const token = await readClaudeToken();
  const response = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" } });
  if (response.status === 401) throw new Error("Claude Code login has expired. Run `claude /login`.");
  if (!response.ok) throw new Error(`Anthropic returned HTTP ${response.status}.`);
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

function render(item: vscode.StatusBarItem, usage: UsageResponse, cost?: Cost): void {
  const session = percentUsed(usage.five_hour);
  const week = percentUsed(usage.seven_day);
  const month = usage.spend?.percent ?? percentUsed(usage.monthly ?? usage.month);
  const spendLabel = formatSpend(usage.spend);
  const mtd = spendLabel ?? (month !== undefined ? `MTD ${month}%` : `S: ${session ?? "–"}% · W: ${week ?? "–"}%`);
  item.text = `$(pulse) Claude ${cost ? `Now ${usd(cost.last)} · Session ${usd(cost.session)} · ` : ""}${mtd}`;
  item.tooltip = [
    "Claude Enterprise Usage",
    session !== undefined ? `Current 5-hour window: ${session}% used${resetText(usage.five_hour)}` : undefined,
    week !== undefined ? `7-day window: ${week}% used${resetText(usage.seven_day)}` : undefined,
    spendLabel ? `Monthly Enterprise spend: ${spendLabel}` : (month !== undefined ? `Monthly usage: ${month}% used${resetText(usage.monthly ?? usage.month)}` : "Monthly field unavailable from Claude Code; open Claude member Usage for the source of truth."),
    cost ? `Last response: ~${usd(cost.last)} · current session: ~${usd(cost.session)} (${cost.model ?? "unknown model"})` : undefined,
    "Request/session costs are API-price estimates calculated from local Claude Code token logs; Enterprise MTD is the server-reported amount.",
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
    cost ? `**Latest response estimate:** ${usd(cost.last)}\n\n**Current session estimate:** ${usd(cost.session)} (${cost.model ?? "unknown model"})` : "**Current response/session cost:** no Claude Code log found.",
    `**5-hour window:** ${percentUsed(usage?.five_hour) ?? "Unavailable"}% used`,
    `**7-day window:** ${percentUsed(usage?.seven_day) ?? "Unavailable"}% used`,
    "",
    `Local snapshots this month: ${history.filter(s => s.recordedAt.startsWith(new Date().toISOString().slice(0, 7))).length}`,
    "",
    "[Open Claude member Usage](https://claude.ai/new#settings/usage)"
  ];
  const doc = await vscode.workspace.openTextDocument({ content: lines.join("\n"), language: "markdown" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function getLatestSessionCost(): Promise<Cost | undefined> {
  let paths: string[];
  try { paths = (await fs.readdir(projectsPath, { recursive: true })).filter(p => p.endsWith(".jsonl")); } catch { return undefined; }
  const candidates = await Promise.all(paths.map(async relative => {
    const absolute = path.join(projectsPath, relative);
    try { return { absolute, mtime: (await fs.stat(absolute)).mtimeMs }; } catch { return undefined; }
  }));
  const latest = candidates.filter((x): x is { absolute: string; mtime: number } => Boolean(x)).sort((a, b) => b.mtime - a.mtime)[0];
  if (!latest) return undefined;
  const records = (await fs.readFile(latest.absolute, "utf8")).split("\n").flatMap(line => { try { return [JSON.parse(line) as LogRecord]; } catch { return []; } });
  const seen = new Set<string>();
  const assistant = records.filter(record => record.type === "assistant" && record.message?.usage && !seen.has(record.uuid ?? "") && (seen.add(record.uuid ?? ""), true));
  const last = assistant.at(-1);
  if (!last?.message?.usage) return undefined;
  const sessionId = last.sessionId;
  const inSession = assistant.filter(record => record.sessionId === sessionId);
  return { last: estimateCost(last.message.model, last.message.usage), session: inSession.reduce((total, record) => total + estimateCost(record.message?.model, record.message?.usage), 0), sessionId, model: last.message.model };
}

type TokenUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } };
type LogRecord = { type?: string; uuid?: string; sessionId?: string; message?: { model?: string; usage?: TokenUsage } };
function estimateCost(model: string | undefined, usage: TokenUsage | undefined): number {
  if (!usage) return 0;
  const name = model?.toLowerCase() ?? "";
  // Standard API rates per million tokens. Enterprise negotiated pricing may differ.
  const base = name.includes("opus") ? [5, 25] : name.includes("haiku") ? [1, 5] : name.includes("sonnet-5") ? [2, 10] : [3, 15];
  const input = (usage.input_tokens ?? 0) * base[0] / 1_000_000;
  const output = (usage.output_tokens ?? 0) * base[1] / 1_000_000;
  const read = (usage.cache_read_input_tokens ?? 0) * base[0] * 0.1 / 1_000_000;
  const oneHour = (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) * base[0] * 2 / 1_000_000;
  const fiveMinutes = ((usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) || usage.cache_creation_input_tokens || 0) * base[0] * 1.25 / 1_000_000;
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
