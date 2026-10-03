import { spawn, type ChildProcess } from "node:child_process";
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
}

export function toAcpMcp(servers: McpServerConfig[]): acp.McpServer[] {
  return servers.map((s): acp.McpServer => {
    if (s.url) {
      return { type: "http", name: s.name, url: s.url, headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })) };
    }
    if (!s.command) throw new Error(`MCP server "${s.name}" needs either a url or a command.`);
    return { name: s.name, command: s.command, args: s.args ?? [], env: Object.entries(s.env ?? {}).map(([name, value]) => ({ name, value })) };
  });
}

/**
 * Backend-specific session options. Overtime agents get only what Overtime gives them:
 * no personal settings, instructions or MCP servers from the person's own CLI setup.
 */
function isolationMeta(backend: string): Record<string, unknown> | undefined {
  if (backend === "claude") return { claudeCode: { options: { settingSources: [], strictMcpConfig: true } } };
  return undefined;
}

/** The backend's fully autonomous mode, if it offers one. */
const AUTONOMOUS_MODES = ["bypassPermissions", "full-access", "yolo", "auto"];

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
    const cmd = await backendCommand(opts.backend);
    const proc = spawn(cmd.command, cmd.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) opts.onStderr?.(line);
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
    const init = await conn.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    self = new AcpSession(proc, conn, init, opts.backend, opts);
    return self;
  }

  get canLoad(): boolean {
    return !!this.init.agentCapabilities?.loadSession;
  }

  async newSession(): Promise<string> {
    const res: acp.NewSessionResponse = await this.conn.agent.request<acp.NewSessionResponse>(acp.methods.agent.session.new, {
      cwd: this.opts.cwd,
      mcpServers: toAcpMcp(this.opts.mcpServers),
      _meta: isolationMeta(this.backend),
    } as any);
    this.sessionId = res.sessionId;
    this.newSessionInfo = res;
    await this.goAutonomous(res.modes as any);
    return res.sessionId;
  }

  /** Continue an earlier session. Returns false if the backend can't, so the caller starts fresh instead. */
  async loadSession(sessionId: string): Promise<boolean> {
    if (!this.canLoad) return false;
    this.sessionId = sessionId;
    this.replaying = true;
    try {
      const res: any = await this.conn.agent.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: this.opts.cwd,
        mcpServers: toAcpMcp(this.opts.mcpServers),
        _meta: isolationMeta(this.backend),
      } as any);
      await this.goAutonomous(res?.modes);
      return true;
    } catch {
      this.sessionId = "";
      return false;
    } finally {
      this.replaying = false;
    }
  }

  private async goAutonomous(modes: { availableModes?: { id: string }[]; currentModeId?: string } | undefined): Promise<void> {
    const ids = modes?.availableModes?.map((m) => m.id) ?? [];
    const target = AUTONOMOUS_MODES.find((m) => ids.includes(m));
    if (!target || modes?.currentModeId === target) return;
    try {
      await this.conn.agent.request(acp.methods.agent.session.setMode, { sessionId: this.sessionId, modeId: target });
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
    return this.conn.agent.request(acp.methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    });
  }

  async cancel(): Promise<void> {
    try {
      await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId });
    } catch {}
  }

  /** Close the connection and make sure the backend process is gone. */
  async close(): Promise<void> {
    try {
      this.conn.close();
    } catch {}
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const t = setTimeout(() => this.proc.kill("SIGKILL"), 3000);
      await new Promise<void>((r) => this.proc.once("exit", () => r()));
      clearTimeout(t);
    }
  }
}
