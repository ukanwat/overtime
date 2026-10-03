import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import { sandboxLaunch } from "../runtime/sandbox.js";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { McpServerConfig } from "../settings.js";
import { backendCommand } from "./backends.js";

export type SessionUpdate = acp.SessionNotification["update"];
export type PermissionRequest = acp.RequestPermissionRequest;
export type PermissionResponse = acp.RequestPermissionResponse;
export type PromptResult = acp.PromptResponse;

export interface OpenOptions {
  backend: string;
  cwd: string;
  mcpServers: McpServerConfig[];
  env?: Record<string, string>;
  /** Every streamed update for this session. */
  onUpdate?: (update: SessionUpdate) => void;
  /** Must answer at once; a session must never wait on a human here. */
  onPermission: (req: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
  /** Backend stderr, for the daemon log. */
  onStderr?: (line: string) => void;
  /** Paths the backend and everything it starts may not write to (enforced by the operating system). */
  protect?: string[];
}

/** Protected paths are set but this machine can't enforce them; the turn doesn't run unprotected. */
export class SandboxUnavailableError extends Error {
  constructor(why: string) {
    super(`Can't protect the paths in your settings: ${why}. Install it, or remove the protected paths.`);
  }
}

/** A readable message from an ACP error: JSON-RPC errors often carry the real reason in `data`. */
export function describeAcpError(e: any, backend: string): string {
  const base = String(e?.message ?? e);
  const d = e?.data;
  const detail = typeof d === "string" ? d : d?.message ?? d?.details ?? d?.error ?? (d ? JSON.stringify(d).slice(0, 300) : "");
  return detail && !base.includes(String(detail)) ? `${backend}: ${base}: ${detail}` : `${backend}: ${base}`;
}

/** How to run the stdio ⇄ HTTP bridge: the built file, or the source through tsx when running from source. */
function bridgeCommand(): { command: string; args: string[] } {
  const js = fileURLToPath(new URL("../tools/bridge.js", import.meta.url));
  if (existsSync(js)) return { command: process.execPath, args: [js] };
  // Running from source (tests): load tsx by absolute path, since the bridge runs in the agent's folder.
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { command: process.execPath, args: ["--import", tsx, fileURLToPath(new URL("../tools/bridge.ts", import.meta.url))] };
}

/**
 * MCP servers in ACP form. A backend that can't connect to HTTP MCP servers itself gets each one through
 * a local bridge command instead, so Overtime's own tools (and URL servers you added) reach every backend.
 */
export function toAcpMcp(servers: McpServerConfig[], http = true): acp.McpServer[] {
  return servers.map((s): acp.McpServer => {
    if (s.url && http) {
      return { type: "http", name: s.name, url: s.url, headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })) };
    }
    if (s.url) {
      const b = bridgeCommand();
      return { name: s.name, command: b.command, args: [...b.args, s.url, JSON.stringify(s.headers ?? {})], env: [] };
    }
    if (!s.command) throw new Error(`MCP server "${s.name}" needs either a url or a command.`);
    return { name: s.name, command: s.command, args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) };
  });
}

/**
 * Claude Code's own tools that do Overtime's jobs across sessions (messaging, waking, scheduling, subagents,
 * asking) or wait on a person in an interactive app. Inside Overtime they do nothing useful, or never
 * return, and the model mistakes them for the real ones; the agent uses Overtime's send, wake, ask and
 * spawn instead. Unknown names are ignored, so the list is safe across Claude Code versions.
 */
export const CLAUDE_BUILTINS_OFF = [
  "Agent", "Task", "SendMessage", "ListAgents", "ScheduleWakeup", "CronCreate", "CronDelete", "CronList",
  "Skill", "RemoteTrigger", "PushNotification", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "Workflow", "Artifact", "SendFeedback", "ClaudeDesign", "Projects", "ProposeGoal", "ProposeSkills", "ShowOnboardingRolePicker", "ReadNotifications",
];

/**
 * Backend-specific session options. Overtime agents get only what Overtime gives them:
 * no personal settings, instructions or MCP servers from the person's own CLI setup.
 */
function isolationMeta(backend: string): Record<string, unknown> | undefined {
  if (backend === "claude") return { claudeCode: { options: { settingSources: [], strictMcpConfig: true, disallowedTools: CLAUDE_BUILTINS_OFF } } };
  return undefined;
}

/**
 * Overtime is the one that answers permission requests, instantly (see runtime/permissions.ts).
 * So sessions run in the backend's normal mode, where risky actions come to Overtime first,
 * rather than a bypass mode where the backend would skip asking.
 */
// Mode names by backend: Claude and Gemini "default"; Codex "workspace-write" (asks the client to step
// outside its sandbox; its "agent" mode would have its own reviewer decide instead, unseen by Overtime).
// A backend with none of these keeps its own default mode.
const ASKING_MODES = ["default", "ask", "workspace-write"];

/** Every open backend session, so a shutdown can close them all. */
const open = new Set<AcpSession>();
const INIT_TIMEOUT_MS = 90_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)))]).finally(() => clearTimeout(t));
}

/**
 * One backend process speaking ACP, holding one session.
 * Overtime opens one of these per active main session, chat and helper, and closes it when the turn is over.
 */
export class AcpSession {
  private constructor(
    private readonly proc: ChildProcess,
    private readonly conn: acp.ClientConnection,
    readonly init: acp.InitializeResponse,
    readonly backend: string,
    private readonly opts: OpenOptions,
    public sessionId: string = "",
    public newSessionInfo: acp.NewSessionResponse | null = null,
    /** While loading an old session the backend replays history; don't treat that as new activity. */
    private replaying = false,
  ) {}

  static async open(opts: OpenOptions): Promise<AcpSession> {
    const base = await backendCommand(opts.backend);
    const protect = opts.protect ?? [];
    const cmd = sandboxLaunch(base.command, base.args, protect);
    if (protect.length && !cmd.sandboxed) throw new SandboxUnavailableError(cmd.why ?? "the sandbox can't start here");
    // Its own process group, so closing it also ends everything it started (CLI, MCP servers, shells).
    const proc = spawn(cmd.command, cmd.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
      detached: true,
    });
    const stderrTail: string[] = [];
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        opts.onStderr?.(line);
      }
    });
    const spawned = await new Promise<Error | null>((resolve) => {
      proc.once("spawn", () => resolve(null));
      proc.once("error", (e) => resolve(e));
    });
    if (spawned) throw new Error(`Could not start backend "${opts.backend}" (${cmd.command}): ${spawned.message}`);

    let self: AcpSession | undefined;
    const app = acp
      .client({ name: "overtime" })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (self && !self.replaying && ctx.params.sessionId === self.sessionId) opts.onUpdate?.(ctx.params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => opts.onPermission(ctx.params));
    const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>);
    const conn = app.connect(stream);
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    let init: acp.InitializeResponse;
    try {
      init = await AcpSession.explain(
        withTimeout(
          conn.agent.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            // notices: backend notes (like "Auto mode unavailable") arrive as their own updates, not mixed into replies.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } } as any,
          }),
          INIT_TIMEOUT_MS,
          `Starting ${opts.backend}`,
        ),
        proc,
        stderrTail,
        opts.backend,
        exited,
      );
    } catch (e) {
      killGroup(proc, "SIGKILL");
      throw e;
    }
    self = new AcpSession(proc, conn, init, opts.backend, opts);
    open.add(self);
    self.stderrTail = stderrTail;
    self.exited = exited;
    return self;
  }

  stderrTail: string[] = [];
  exited: Promise<void> = Promise.resolve();

  /** Turn "connection closed" into the backend's own last words, so failures say what actually went wrong. */
  static async explain<T>(p: Promise<T>, proc: ChildProcess, tail: string[], backend: string, exited: Promise<void>): Promise<T> {
    try {
      return await p;
    } catch (e: any) {
      await Promise.race([exited, new Promise((r) => setTimeout(r, 500))]);
      if (proc.exitCode !== null || proc.signalCode) {
        const last = tail.filter((l) => !/^\s+at /.test(l)).slice(-6).join(" | ");
        throw new Error(`The ${backend} backend stopped (${proc.signalCode ?? `exit ${proc.exitCode}`})${last ? `: ${last}` : ""}`);
      }
      throw new Error(describeAcpError(e, backend));
    }
  }

  private wrap<T>(p: Promise<T>): Promise<T> {
    return AcpSession.explain(p, this.proc, this.stderrTail, this.backend, this.exited);
  }

  /** Whether the backend connects to HTTP MCP servers itself (ACP mcpCapabilities.http). */
  get httpMcp(): boolean {
    return !!(this.init.agentCapabilities as any)?.mcpCapabilities?.http;
  }

  get canLoad(): boolean {
    return !!this.init.agentCapabilities?.loadSession;
  }

  async newSession(): Promise<string> {
    const res: acp.NewSessionResponse = await this.wrap(
      withTimeout(
        this.conn.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
          cwd: this.opts.cwd,
          mcpServers: toAcpMcp(this.opts.mcpServers, this.httpMcp),
          _meta: isolationMeta(this.backend),
        } as any),
        INIT_TIMEOUT_MS,
        "Creating a session",
      ),
    );
    this.sessionId = res.sessionId;
    this.newSessionInfo = res;
    await this.goAutonomous(res.modes as any, (res as any).configOptions);
    return res.sessionId;
  }

  /** Continue an earlier session. Returns false if the backend can't, so the caller starts fresh instead. */
  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.canLoad) return false;
    this.sessionId = sessionId;
    this.replaying = true;
    try {
      const res: any = await withTimeout(
        this.conn.agent.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: this.opts.cwd,
          mcpServers: toAcpMcp(this.opts.mcpServers, this.httpMcp),
          _meta: isolationMeta(this.backend),
        } as any),
        INIT_TIMEOUT_MS,
        "Loading the session",
      );
      await this.goAutonomous(res?.modes, res?.configOptions);
      return true;
    } catch {
      this.sessionId = "";
      return false;
    } finally {
      this.replaying = false;
    }
  }

  private async goAutonomous(modes: { availableModes?: { id: string }[]; currentModeId?: string } | undefined, configOptions?: any[]): Promise<void> {
    const ids = modes?.availableModes?.map((m) => m.id) ?? [];
    const target = ASKING_MODES.find((m) => ids.includes(m));
    if (target && modes?.currentModeId !== target) {
      try {
        await this.conn.agent.request(acp.methods.agent.session.setMode, { sessionId: this.sessionId, modeId: target });
      } catch {}
      return;
    }
    if (target) return;
    // Backends that offer the mode as a config option instead of session modes.
    const opt = configOptions?.find((o: any) => o?.category === "mode" && Array.isArray(o.options));
    const value = opt && ASKING_MODES.find((m) => opt.options.some((x: any) => (x.value ?? x.id) === m));
    if (!opt || !value || opt.currentValue === value) return;
    try {
      await this.conn.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: opt.id, value } as any);
    } catch {}
  }

  /** Pick a model through the backend's own config options (falls back to the older set_model call). */
  async setModel(model: string): Promise<boolean> {
    const opt = this.newSessionInfo?.configOptions?.find((o: any) => o.category === "model");
    try {
      if (opt) {
        await this.conn.agent.request(acp.methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: (opt as any).id, value: model } as any);
      } else {
        await this.conn.agent.request("session/set_model", { sessionId: this.sessionId, modelId: model });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Models the backend says it offers, for the model picker. */
  availableModels(): { id: string; name: string }[] {
    const opt: any = this.newSessionInfo?.configOptions?.find((o: any) => o.category === "model");
    if (opt?.options) return opt.options.map((o: any) => ({ id: o.value, name: o.name ?? o.value }));
    const legacy: any = (this.newSessionInfo as any)?.models?.availableModels;
    return legacy ? legacy.map((m: any) => ({ id: m.modelId, name: m.name ?? m.modelId })) : [];
  }

  async prompt(text: string): Promise<PromptResult> {
    return this.wrap(
      this.conn.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      }),
    );
  }

  async cancel(): Promise<void> {
    try {
      await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
    } catch {}
  }

  /** Close the connection and make sure the backend and everything it started are gone. */
  async close(): Promise<void> {
    open.delete(this);
    // Politely first: end its input and keep reading what it still writes (a closing backend often
    // sends final updates), so it exits on its own instead of crashing on a closed pipe.
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      try {
        this.proc.stdin?.end();
      } catch {}
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    try {
      this.conn.close();
    } catch {}
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      killGroup(this.proc, "SIGTERM");
      const t = setTimeout(() => killGroup(this.proc, "SIGKILL"), 3000);
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 5000))]);
      clearTimeout(t);
    }
    // Anything the backend left behind in its group.
    killGroup(this.proc, "SIGKILL");
  }

  /** Close every open backend session (daemon shutdown). */
  static async closeAll(): Promise<void> {
    await Promise.allSettled([...open].map((s) => s.close()));
  }
}

function killGroup(p: ChildProcess, sig: NodeJS.Signals): void {
  if (!p.pid) return;
  try {
    process.kill(-p.pid, sig);
  } catch {
    try {
      p.kill(sig);
    } catch {}
  }
}
