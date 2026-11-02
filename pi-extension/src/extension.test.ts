import { describe, expect, test, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { SessionManager, type ExtensionAPI, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { decodeServerFrameV2 } from "./protocol/v2/index.js";
import { resetExtensionOwnerForTest } from "./runtime/extension_owner.js";

type OwnerRecord = { name: string; remote_epk: string; paired_at: string };
const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const relays: MockRelay[] = [];
const owners: OwnerRecord[] = [];
let nextIdentity: (() => Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }>) | null = null;
let nextPeerList: (() => Promise<OwnerRecord[]>) | null = null;
let nextRelayConnect: (() => Promise<void>) | null = null;
let nextAddPeer: (() => Promise<void>) | null = null;
const listPeers = vi.fn(() => nextPeerList?.() ?? Promise.resolve([...owners]));
const addPeer = vi.fn(async (owner: OwnerRecord) => {
  await nextAddPeer?.();
  const index = owners.findIndex((entry) => entry.remote_epk === owner.remote_epk);
  if (index >= 0) owners[index] = owner; else owners.push(owner);
  return { record: owner, token: Object.freeze({}) };
});
const conditionalRollbackPeer = vi.fn(async (receipt: { record: OwnerRecord }) => {
  const index = owners.findIndex((entry) => entry === receipt.record);
  if (index < 0) return { outcome: "stale" };
  owners.splice(index, 1);
  return { outcome: "removed", nextToken: Object.freeze({}) };
});

class MockRelay extends EventEmitter {
  static OPEN = 1;
  readyState = MockRelay.OPEN;
  private rejectConnect: ((reason?: unknown) => void) | null = null;
  connect = vi.fn(() => new Promise<void>((resolve, reject) => {
    this.rejectConnect = reject;
    void (nextRelayConnect?.() ?? Promise.resolve()).then(
      () => { if (this.rejectConnect === reject) this.rejectConnect = null; resolve(); },
      (error: unknown) => { if (this.rejectConnect === reject) this.rejectConnect = null; reject(error); },
    );
  }));
  send = vi.fn();
  sendControl = vi.fn(() => true);
  close = vi.fn(() => {
    this.readyState = 3;
    const reject = this.rejectConnect;
    this.rejectConnect = null;
    reject?.(new Error("Relay closed"));
  });
  isOpen = vi.fn(() => this.readyState === MockRelay.OPEN);
  constructor() { super(); relays.push(this); }
}

function readyFrame(relay: MockRelay) {
  const frames = relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from((JSON.parse(line) as { ct: string }).ct, "base64").toString("utf8")));
  const ready = frames.findLast((frame) => frame.type === "session_ready");
  if (!ready) throw new Error("expected session_ready");
  return ready;
}

vi.mock("./transport/relay_client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport/relay_client.js")>()),
  RelayClient: MockRelay,
}));

vi.mock("./pairing/storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pairing/storage.js")>();
  return {
    ...original,
    getOrCreateEd25519Keypair: vi.fn(() => nextIdentity?.() ?? Promise.resolve({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) })),
    listPeers,
    addPeer,
    conditionalRollbackPeer,
    removePeer: vi.fn().mockImplementation(async (ownerId) => {
      const index = owners.findIndex((owner) => owner.remote_epk === ownerId);
      if (index < 0) return false;
      owners.splice(index, 1);
      return true;
    }),
  };
});

const pairingTokenState = vi.hoisted(() => ({
  reservation: null as { code: string; ownerId: string; requestId: string } | null,
  completion: null as unknown,
  invite: null as { code: string; expiresAt: number } | null,
  released: false,
}));
vi.mock("./pairing/qr.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pairing/qr.js")>();
  return {
    ...original,
    qrSession: {
      issueCode: vi.fn(() => {
        const invite = { code: "ABCD2345", expiresAt: Date.now() + 300_000 };
        pairingTokenState.invite = invite;
        return invite;
      }),
      getActiveInvite: vi.fn(() => pairingTokenState.invite),
      reserveCode: vi.fn((code: string, ownerId: string, requestId: string) => {
        if (pairingTokenState.completion && pairingTokenState.reservation?.ownerId === ownerId && pairingTokenState.reservation.requestId === requestId) {
          return { status: "committed", completion: pairingTokenState.completion };
        }
        if (pairingTokenState.reservation && (pairingTokenState.reservation.ownerId !== ownerId || pairingTokenState.reservation.requestId !== requestId)) return { status: "consumed" };
        if (!pairingTokenState.reservation || pairingTokenState.released) pairingTokenState.reservation = Object.freeze({ code, ownerId, requestId });
        pairingTokenState.released = false;
        return { status: "reserved", reservation: pairingTokenState.reservation };
      }),
      commitCode: vi.fn((reservation: unknown, completion: unknown) => {
        if (reservation !== pairingTokenState.reservation) return false;
        pairingTokenState.completion = completion;
        return true;
      }),
      isReservationCurrent: vi.fn((reservation: unknown) => reservation === pairingTokenState.reservation && pairingTokenState.completion === null && !pairingTokenState.released),
      releaseCode: vi.fn((reservation: unknown) => {
        if (reservation !== pairingTokenState.reservation) return false;
        pairingTokenState.released = true;
        return true;
      }),
      clear: vi.fn(() => { pairingTokenState.reservation = null; pairingTokenState.completion = null; pairingTokenState.invite = null; pairingTokenState.released = false; }),
    },
  };
});

const {
  default: extension, _connectForTest, _stopForTest, _getState, _getCachedPublicKeyForTest, _hasPendingReconnect, processEndpointIdentity,
  _setSessionNewBridgeTimeoutForTest, _setDisposedForTest, _getActivePeerCountForTest,
} = await import("./index.js");

function makePi(): ExtensionAPI & { handlers: Map<string, Function>; commands: Map<string, Function>; sent: unknown[] } {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, Function>();
  const sent: unknown[] = [];
  return {
    handlers,
    commands,
    sent,
    registerCommand: vi.fn((name, definition) => commands.set(name, definition.handler)),
    registerTool: vi.fn(),
    on: vi.fn((name, handler) => handlers.set(name, handler)),
    sendMessage: vi.fn((message) => sent.push(message)),
    getThinkingLevel: vi.fn(),
  } as unknown as ExtensionAPI & { handlers: Map<string, Function>; commands: Map<string, Function>; sent: unknown[] };
}

type TestMode = "tui" | "rpc" | "json" | "print";

function ctx(mode: TestMode = "tui") {
  return {
    mode,
    cwd: "/tmp/pi-reach-endpoint-test",
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
      setTitle: vi.fn(),
      setWidget: vi.fn(),
      theme: { fg: vi.fn((_color: string, text: string) => text) },
    },
    abort: vi.fn(),
    isIdle: vi.fn(() => true),
  };
}

function latestRelayStatus(context: ReturnType<typeof ctx>): unknown {
  return [...context.ui.setStatus.mock.calls].reverse().find(([key]) => key === "pi-reach:relay")?.[1];
}

function sourceOwner(): string {
  return ownerId(7);
}

function ownerId(value: number): string {
  return Buffer.alloc(32, value).toString("base64");
}

function inbound(
  identity: ReturnType<typeof processEndpointIdentity>,
  inner: unknown,
  purpose: "pairing" | "session" = "pairing",
  owner = sourceOwner(),
): string {
  return JSON.stringify({
    type: "route",
    purpose,
    device_id: Buffer.alloc(32, 1).toString("base64"),
    endpoint_id: identity.endpointId,
    runtime_instance_id: identity.runtimeInstanceId,
    source_owner_id: owner,
    ct: Buffer.from(JSON.stringify(inner)).toString("base64"),
  });
}

describe("Pi Reach endpoint extension", () => {
  beforeEach(async () => {
    resetExtensionOwnerForTest();
    owners.length = 0;
    relays.length = 0;
    nextIdentity = null;
    nextPeerList = null;
    nextRelayConnect = null;
    nextAddPeer = null;
    listPeers.mockClear();
    addPeer.mockClear();
    conditionalRollbackPeer.mockClear();
    pairingTokenState.reservation = null;
    pairingTokenState.completion = null;
    pairingTokenState.invite = null;
    pairingTokenState.released = false;
    _setSessionNewBridgeTimeoutForTest(5_000);
    await _stopForTest(ctx());
    _setDisposedForTest(false);
  });

  test("keeps endpoint and runtime identity process-scoped", () => {
    expect(processEndpointIdentity()).toBe(processEndpointIdentity());
    expect(processEndpointIdentity().endpointId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(processEndpointIdentity().runtimeInstanceId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("registers publish_file as a sequential single-file tool", () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const tools = vi.mocked(pi.registerTool).mock.calls.map(([tool]) => tool);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "publish_file", executionMode: "sequential" });
    expect(tools[0]?.parameters).toMatchObject({ type: "object", required: ["path"] });
  });

  test("announces runtime readiness through Pi and RPC status", () => {
    const pi = makePi();
    const context = { ...ctx("rpc"), sessionManager: SessionManager.inMemory(process.cwd()) };
    (extension as ExtensionFactory)(pi);

    pi.handlers.get("session_start")!({}, context);

    expect(pi.sent).toContainEqual(expect.objectContaining({
      customType: "pi-reach:runtime-ready",
      details: expect.objectContaining({
        control_protocol_version: 2,
        extension_version: packageVersion,
        endpoint_id: processEndpointIdentity().endpointId,
        runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
        session_id: context.sessionManager.getSessionId(),
      }),
    }));
    const controlStatus = context.ui.setStatus.mock.calls.find(([key]) => key === "pi-reach:control")?.[1];
    expect(controlStatus).toEqual(expect.any(String));
    expect(JSON.parse(controlStatus as string)).toMatchObject({
      type: "runtime_ready",
      control_protocol_version: 2,
      extension_version: packageVersion,
      endpoint_id: processEndpointIdentity().endpointId,
      runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
      session_id: context.sessionManager.getSessionId(),
    });
  });

  test.each(["tui", "json", "print"] as const)("keeps runtime readiness out of %s status output", (mode) => {
    const pi = makePi();
    const context = { ...ctx(mode), sessionManager: SessionManager.inMemory(process.cwd()) };
    (extension as ExtensionFactory)(pi);

    pi.handlers.get("session_start")!({}, context);

    expect(pi.sent).toContainEqual(expect.objectContaining({ customType: "pi-reach:runtime-ready" }));
    const controlStatuses = context.ui.setStatus.mock.calls
      .filter(([key]) => key === "pi-reach:control")
      .map(([, text]) => text);
    expect(controlStatuses.some((text) => typeof text === "string")).toBe(false);
    if (mode === "tui") expect(latestRelayStatus(context)).toBeDefined();
    else expect(latestRelayStatus(context)).toBeUndefined();
  });

  test("renders TUI relay states through session startup and commands", async () => {
    let resolveIdentity!: (identity: { publicKey: Uint8Array; secretKey: Uint8Array }) => void;
    nextIdentity = () => new Promise((resolve) => { resolveIdentity = resolve; });
    const pi = makePi();
    const context = { ...ctx("tui"), sessionManager: SessionManager.inMemory(process.cwd()) };
    (extension as ExtensionFactory)(pi);

    pi.handlers.get("session_start")!({}, context);
    expect(latestRelayStatus(context)).toBeDefined();
    expect(context.ui.setStatus).toHaveBeenCalledWith("pi-reach:control", undefined);
    expect(context.ui.setStatus).toHaveBeenCalledWith("pi-reach:owner-active", undefined);
    expect(context.ui.setStatus).toHaveBeenCalledWith("pi-reach:session", undefined);

    resolveIdentity({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) });
    await vi.waitFor(() => expect(relays).toHaveLength(1));
    // Synchronize on the protocol-level relay states instead of the rendered footer wording, so the
    // test keeps working when the footer text is translated.
    const relayStates = () =>
      pi.sent
        .filter((message) => (message as { customType: string }).customType === "pi-reach:relay-state")
        .map((message) => (message as { details: { state: string } }).details.state);
    await vi.waitFor(() => expect(relayStates()).toEqual(["reconnecting", "connected"]));
    expect(latestRelayStatus(context)).toBeDefined();

    vi.useFakeTimers();
    try {
      relays[0]!.emit("close");
      expect(_getActivePeerCountForTest()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(relays).toHaveLength(2);
      expect(relayStates()).toContain("connected");
    } finally {
      vi.useRealTimers();
    }

    await pi.commands.get("pi-reach stop")!("", context);
    expect(latestRelayStatus(context)).toBeDefined();

    nextIdentity = async () => { throw new Error("identity startup blocked"); };
    await pi.commands.get("pi-reach start")!("", context);
    // The failure is verified through the error-colored status, not the rendered wording.
    expect(context.ui.theme.fg).toHaveBeenCalledWith("error", expect.any(String));
    expect(latestRelayStatus(context)).toBeDefined();
    nextIdentity = null;
    await pi.commands.get("pi-reach start")!("", context);
    expect(latestRelayStatus(context)).toBeDefined();
  });

  test("reports automatic startup failures without an unhandled rejection", async () => {
    nextIdentity = async () => { throw new Error("identity startup blocked"); };
    const pi = makePi();
    const context = { ...ctx(), sessionManager: SessionManager.inMemory(process.cwd()) };
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")!({ reason: "startup" }, context);

    await vi.waitFor(() => expect(context.ui.notify).toHaveBeenCalledWith("[pi-reach] Startup failed: Error: identity startup blocked", "error"));
    expect(latestRelayStatus(context)).toBeDefined();
  });

  test("refreshes the current TUI after reload without writing to the old UI", async () => {
    const pi = makePi();
    const manager = SessionManager.inMemory(process.cwd());
    const context = { ...ctx(), sessionManager: manager };
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")!({ reason: "startup" }, context);
    await _connectForTest(context);
    pi.handlers.get("session_shutdown")!({ reason: "reload" });
    context.ui.setStatus.mockClear();

    const reloaded = makePi();
    const current = { ...ctx(), sessionManager: manager };
    (extension as ExtensionFactory)(reloaded);
    reloaded.handlers.get("session_start")!({ reason: "reload" }, current);
    expect(latestRelayStatus(current)).toBeDefined();
    expect(current.ui.setStatus).toHaveBeenCalledWith("pi-reach:control", undefined);
    await reloaded.commands.get("pi-reach stop")!("", current);
    expect(latestRelayStatus(current)).toBeDefined();
    expect(context.ui.setStatus).not.toHaveBeenCalled();
  });

  test("announces the trimmed current session name in initial Relay metadata", async () => {
    const pi = makePi();
    const manager = SessionManager.inMemory(process.cwd());
    manager.appendSessionInfo("  Release notes  ");
    const context = { ...ctx(), sessionManager: manager };
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")!({ reason: "startup" }, context);
    await _connectForTest(context);

    expect(relays.at(-1)!.connect).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ name: "Release notes" }),
    }));
  });

  test("refreshes connected metadata when the session name changes or clears", async () => {
    const pi = makePi();
    const manager = SessionManager.inMemory(process.cwd());
    const context = { ...ctx(), sessionManager: manager };
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")!({ reason: "startup" }, context);
    await _connectForTest(context);
    const relay = relays.at(-1)!;
    relay.sendControl.mockClear();

    manager.appendSessionInfo("  Renamed session  ");
    pi.handlers.get("session_info_changed")!({ name: "Renamed session" });
    await vi.waitFor(() => expect(relay.sendControl).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "endpoint_update",
      metadata: expect.objectContaining({ name: "Renamed session" }),
    })));

    relay.sendControl.mockClear();
    manager.appendSessionInfo("");
    pi.handlers.get("session_info_changed")!({ name: undefined });
    await vi.waitFor(() => expect(relay.sendControl).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "endpoint_update",
      metadata: expect.objectContaining({ name: "Untitled session" }),
    })));
  });

  test("reports working for the whole run instead of each model turn", async () => {
    const pi = makePi();
    const manager = SessionManager.inMemory(process.cwd());
    const context = { ...ctx(), sessionManager: manager };
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")!({ reason: "startup" }, context);
    await _connectForTest(context);
    const relay = relays.at(-1)!;
    relay.sendControl.mockClear();
    const workingUpdates = () => relay.sendControl.mock.calls
      .map(([frame]) => frame as { type: string; metadata?: { working?: boolean } })
      .filter((frame) => frame.type === "endpoint_update")
      .map((frame) => frame.metadata?.working);

    pi.handlers.get("agent_start")!({}, context);
    pi.handlers.get("turn_start")?.({}, context);
    pi.handlers.get("turn_end")?.({}, context);
    pi.handlers.get("turn_start")?.({}, context);
    await vi.waitFor(() => expect(workingUpdates()).toEqual([true]));

    pi.handlers.get("turn_end")?.({}, context);
    pi.handlers.get("agent_end")!({ messages: [] }, context);
    await vi.waitFor(() => expect(workingUpdates()).toEqual([true, false]));
  });

  test("uses an untitled replacement session and ignores stale owner name events", async () => {
    const oldPi = makePi();
    const oldManager = SessionManager.inMemory(process.cwd());
    oldManager.appendSessionInfo("Previous session");
    const oldContext = { ...ctx(), sessionManager: oldManager };
    (extension as ExtensionFactory)(oldPi);
    oldPi.handlers.get("session_start")!({ reason: "startup" }, oldContext);
    await _connectForTest(oldContext);
    const relay = relays.at(-1)!;
    relay.sendControl.mockClear();

    oldPi.handlers.get("session_shutdown")!({ reason: "new" });
    const currentPi = makePi();
    const currentManager = SessionManager.inMemory(process.cwd());
    const currentContext = { ...ctx(), sessionManager: currentManager };
    (extension as ExtensionFactory)(currentPi);
    currentPi.handlers.get("session_start")!({ reason: "new", previousSessionFile: oldManager.getSessionFile() }, currentContext);

    await vi.waitFor(() => expect(relay.sendControl).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "endpoint_update",
      metadata: expect.objectContaining({ name: "Untitled session" }),
    })));
    expect(relays).toHaveLength(1);

    relay.sendControl.mockClear();
    oldManager.appendSessionInfo("Stale session");
    oldPi.handlers.get("session_info_changed")!({ name: "Stale session" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(relay.sendControl).not.toHaveBeenCalled();
  });

  test("connects as a Relay host with endpoint identity and Owner ACL", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    await _connectForTest(ctx());
    expect(_getState()).toBe("started");
    const relay = relays.at(-1)!;
    expect(relay.connect).toHaveBeenCalledWith(expect.objectContaining({
      role: "host",
      endpointId: processEndpointIdentity().endpointId,
      runtimeInstanceId: processEndpointIdentity().runtimeInstanceId,
      authorizedOwnerIds: [sourceOwner()],
      metadata: expect.objectContaining({ kind: "interactive", pid: process.pid }),
    }));
    await _connectForTest(ctx());
    expect(relays).toHaveLength(1);
  });

  test("reports the extension version through an explicit query after session_hello", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = SessionManager.inMemory(process.cwd());
    const context = { ...ctx(), sessionManager: manager };
    pi.handlers.get("session_start")!({}, context);
    await _connectForTest(context);
    const relay = relays.at(-1)!;
    const frames = () => relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from((JSON.parse(line) as { ct: string }).ct, "base64").toString("utf8")));

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "extension_info_request", id: "info-early", channel_id: "channel-info", session_id: manager.getSessionId(), leaf_id: manager.getLeafId() ?? null }, "session"));
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "protocol_error", code: "invalid_channel", in_reply_to: "info-early" })));

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "info-hello", channel_id: "channel-info" }, "session"));
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "session_ready" })));
    const ready = frames().find((frame) => frame.type === "session_ready")!;
    expect(ready).not.toHaveProperty("extension_version");

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "extension_info_request", id: "info-1", channel_id: "channel-info", session_id: ready.session_id, leaf_id: ready.leaf_id }, "session"));
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "extension_info", in_reply_to: "info-1", version: packageVersion, target_channel_id: "channel-info" })));
  });

  test("broadcasts tool lifecycle snapshots and a persisted final result through the production handlers", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = SessionManager.inMemory(process.cwd());
    const context = { ...ctx(), sessionManager: manager };
    pi.handlers.get("session_start")!({}, context);
    await _connectForTest(context);
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-tools", channel_id: "channel-tools" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    relay.send.mockClear();
    const assistant = { role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "wire-call", name: "read", arguments: { path: "README.md" } }] };
    pi.handlers.get("agent_start")!({}, context);
    pi.handlers.get("message_start")!({ message: assistant }, context);
    pi.handlers.get("message_end")!({ message: assistant }, context);
    manager.appendMessage(assistant as never);
    pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "wire-call", toolName: "read", args: { path: "README.md" } }, context);
    pi.handlers.get("tool_execution_update")!({ type: "tool_execution_update", toolCallId: "wire-call", toolName: "read", args: {}, partialResult: { content: [{ type: "text", text: "preview" }] } }, context);
    const result = { content: [{ type: "text", text: "complete output" }] };
    pi.handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "wire-call", toolName: "read", result, isError: false }, context);
    const tool = { role: "toolResult", timestamp: 2, toolCallId: "wire-call", toolName: "read", ...result, isError: false };
    pi.handlers.get("message_start")!({ message: tool }, context);
    pi.handlers.get("message_end")!({ message: tool }, context);
    // 其他扩展异步处理 message_end 时，SDK 还没有写入正式工具消息。
    await new Promise<void>((resolve) => setImmediate(resolve));
    manager.appendMessage(tool as never);
    pi.handlers.get("turn_end")!({}, context);
    expect(relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from(JSON.parse(line).ct, "base64").toString("utf8"))))
      .toContainEqual(expect.objectContaining({ type: "timeline_event", event: expect.objectContaining({ kind: "tool", tool_call_id: "wire-call" }) }));
    pi.handlers.get("agent_end")!({ messages: [assistant, tool] }, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const frames = relay.send.mock.calls.map(([line]) => {
      const outer = JSON.parse(line) as { target_owner_id: string; ct: string };
      expect(outer.target_owner_id).toBe(sourceOwner());
      return decodeServerFrameV2(Buffer.from(outer.ct, "base64").toString("utf8"));
    });
    expect(frames.filter((frame) => frame.type === "timeline_partial")).toEqual([
      expect.objectContaining({ kind: "tool", status: "running", args: { path: "README.md" }, partial_id: "tool:wire-call" }),
      expect.objectContaining({ blocks: [{ type: "text", text: "preview" }] }),
      expect.objectContaining({ blocks: [{ type: "text", text: "complete output" }] }),
    ]);
    expect(frames).toContainEqual(expect.objectContaining({ type: "timeline_event", event: expect.objectContaining({ kind: "tool", tool_call_id: "wire-call", args: { path: "README.md" }, result: result.content }) }));
    const formal = frames.filter((frame) => frame.type === "timeline_event");
    expect(formal.map((frame) => [frame.event.kind, frame.event.event_seq])).toEqual([["assistant", 1], ["tool", 2], ["run_end", 3]]);
    expect(formal.at(-1)?.event.group_id).toBe(formal[0]?.event.group_id);
  });

  test("keeps the primary endpoint and timeline alive across an in-process child session", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const primary = makePi();
    (extension as ExtensionFactory)(primary);
    const manager = SessionManager.inMemory(process.cwd());
    const context = { ...ctx(), sessionManager: manager };
    primary.handlers.get("session_start")!({ reason: "startup" }, context);
    await _connectForTest(context);
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "primary-hello", channel_id: "primary-channel" }, "session"));
    const frames = () => relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from(JSON.parse(line).ct, "base64").toString("utf8")));
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "session_ready" })));
    const ready = frames().find((frame) => frame.type === "session_ready")!;

    const child = makePi();
    (extension as ExtensionFactory)(child);
    const childManager = SessionManager.inMemory(process.cwd());
    childManager.newSession({ parentSession: manager.getSessionId() });
    const childContext = { ...ctx(), sessionManager: childManager };
    child.handlers.get("session_start")?.({ reason: "startup" }, childContext);
    child.handlers.get("agent_start")?.({}, childContext);
    child.handlers.get("model_select")?.({ model: { id: "child-model" } }, childContext);

    const message = { role: "assistant", timestamp: 1, stopReason: "stop", content: [{ type: "text", text: "primary output after child start" }] };
    primary.handlers.get("agent_start")!({}, context);
    primary.handlers.get("message_start")!({ message }, context);
    primary.handlers.get("message_end")!({ message }, context);
    manager.appendMessage(message as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(frames()).toContainEqual(expect.objectContaining({ type: "timeline_event", event: expect.objectContaining({ session_id: ready.session_id, leaf_id: expect.any(String) }) }));
    expect(child.sent).toEqual([]);
    expect(relays).toHaveLength(1);

    child.handlers.get("session_shutdown")?.({ reason: "quit" }, childContext);
    expect(relay.close).not.toHaveBeenCalled();
    expect(_getState()).toBe("paired");
    expect(frames().filter((frame) => frame.type === "bye")).toEqual([]);
    primary.handlers.get("session_shutdown")!({ reason: "quit" }, context);
    expect(relay.close).toHaveBeenCalledOnce();
  });

  test.each([false, true])("keeps queued output within its wire scope when replacement starts before flush: %s", async (startBeforeFlush) => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const primary = makePi();
    (extension as ExtensionFactory)(primary);
    const manager = SessionManager.inMemory(process.cwd());
    const context = { ...ctx(), sessionManager: manager };
    primary.handlers.get("session_start")!({ reason: "startup" }, context);
    await _connectForTest(context);
    const relay = relays.at(-1)!;
    const hello = (id: string) => relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id, channel_id: "handoff-channel" }, "session"));
    const frames = () => relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from(JSON.parse(line).ct, "base64").toString("utf8")));
    hello("old-hello");
    await vi.waitFor(() => expect(frames().some((frame) => frame.type === "session_ready")).toBe(true));
    const oldReady = frames().find((frame) => frame.type === "session_ready")!;
    relay.send.mockClear();

    const message = { role: "assistant", timestamp: 1, stopReason: "stop", content: [{ type: "text", text: "last valid old-session output" }] };
    primary.handlers.get("agent_start")!({}, context);
    primary.handlers.get("message_start")!({ message }, context);
    primary.handlers.get("message_end")!({ message }, context);
    manager.appendMessage(message as never);
    primary.handlers.get("session_shutdown")!({ reason: "new" }, context);
    const replacement = makePi();
    (extension as ExtensionFactory)(replacement);
    const newManager = SessionManager.inMemory(process.cwd());
    const startReplacement = () => replacement.handlers.get("session_start")!({ reason: "new", previousSessionFile: manager.getSessionFile() }, { ...ctx(), sessionManager: newManager });
    if (startBeforeFlush) startReplacement();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const output = frames().filter((frame) => frame.type === "timeline_event");
    if (startBeforeFlush) expect(output).toEqual([]);
    else {
      expect(output).toHaveLength(1);
      expect(output[0]).toMatchObject({ session_id: oldReady.session_id, leaf_id: expect.any(String), event: { session_id: oldReady.session_id, leaf_id: expect.any(String) } });
      expect(frames().some((frame) => frame.type === "bye")).toBe(false);
      startReplacement();
    }
    expect(frames().at(-1)).toMatchObject({ type: "bye", session_id: oldReady.session_id, reason: "session_replaced" });
    hello("new-hello");
    await vi.waitFor(() => expect(frames()).toContainEqual(expect.objectContaining({ type: "session_ready", session_id: newManager.getSessionId() })));
    expect(relay.close).not.toHaveBeenCalled();
  });

  test("serializes ACL snapshots so a newer authorization update is sent last", async () => {
    const ownerA = sourceOwner();
    const ownerB = ownerId(8);
    owners.push({ name: "owner-a", remote_epk: ownerA, paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.sendControl.mockClear();
    let resolveStaleSnapshot!: (peers: OwnerRecord[]) => void;
    let reads = 0;
    nextPeerList = () => {
      reads += 1;
      return reads === 1
        ? new Promise<OwnerRecord[]>((resolve) => { resolveStaleSnapshot = resolve; })
        : Promise.resolve([...owners]);
    };

    pi.handlers.get("model_select")?.({ model: { id: "first" } });
    await vi.waitFor(() => expect(listPeers).toHaveBeenCalledOnce());
    owners.splice(0, owners.length, { name: "owner-b", remote_epk: ownerB, paired_at: "later" });
    pi.handlers.get("model_select")?.({ model: { id: "second" } });
    expect(relay.sendControl).not.toHaveBeenCalled();

    resolveStaleSnapshot([{ name: "owner-a", remote_epk: ownerA, paired_at: "now" }]);
    await vi.waitFor(() => expect(relay.sendControl).toHaveBeenCalledTimes(2));
    expect(relay.sendControl.mock.calls.map(([frame]) => (frame as { authorized_owner_ids: string[] }).authorized_owner_ids)).toEqual([
      [ownerA],
      [ownerB],
    ]);
  });

  test("waits for session-start identity and Relay connection before generating a pairing QR", async () => {
    let resolveIdentity!: (keypair: { publicKey: Uint8Array; secretKey: Uint8Array }) => void;
    let resolveConnect!: () => void;
    nextIdentity = () => new Promise((resolve) => { resolveIdentity = resolve; });
    nextRelayConnect = () => new Promise<void>((resolve) => { resolveConnect = resolve; });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: { getSessionId: () => "session-pair", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-pair" } });
      const pairContext = ctx();
      const pairPromise = pi.commands.get("pi-reach pair")!("", pairContext);
      expect(relays).toHaveLength(0);
      expect(pairContext.ui.notify).not.toHaveBeenCalledWith("[pi-reach] Already connected.", "warning");

      resolveIdentity({ publicKey: new Uint8Array(32).fill(1), secretKey: new Uint8Array(32).fill(2) });
      await vi.waitFor(() => expect(relays).toHaveLength(1));
      expect(pi.sent.some((message) => (message as { customType?: string }).customType === "pi-reach:pair-code")).toBe(false);

      resolveConnect();
      await pairPromise;

      expect(relays[0]!.connect).toHaveBeenCalledOnce();
      expect(pairContext.ui.notify).not.toHaveBeenCalledWith("[pi-reach] Already connected.", "warning");
      expect(pairContext.ui.setWidget).toHaveBeenCalledWith(
        "pi-reach-pair-code",
        expect.arrayContaining(["Scan to pair:", expect.stringMatching(/^Pairing code: [0-9A-HJKMNP-TV-Z]{8}$/), expect.stringContaining("Expires at:")]),
      );
      expect(pairContext.ui.setWidget.mock.calls.at(-1)?.[1]).not.toContainEqual(expect.stringContaining("://pair?"));
      expect(relays[0]!.sendControl).toHaveBeenCalledWith(expect.objectContaining({
        type: "pairing_offer",
        code: "ABCD2345",
        endpoint_id: processEndpointIdentity().endpointId,
        runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
        expires_at: expect.any(Number),
      }));
  });

  test("stopping a pending Relay connect releases pair and isolates the next start", async () => {
    nextRelayConnect = () => new Promise<void>(() => undefined);
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: { getSessionId: () => "session-stop", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-stop" } });
      await vi.waitFor(() => expect(relays).toHaveLength(1));
      const pairContext = ctx();
      const pairPromise = pi.commands.get("pi-reach pair")!("", pairContext);

      await pi.commands.get("pi-reach stop")!("", ctx());
      await pairPromise;

      expect(relays[0]!.close).toHaveBeenCalledOnce();
      expect(pi.sent.some((message) => (message as { customType?: string }).customType === "pi-reach:pair-code")).toBe(false);
      expect(pairContext.ui.notify).toHaveBeenCalledWith("[pi-reach] Pair requires a Relay connection; current state: disconnected.", "warning");

      nextRelayConnect = null;
      await _connectForTest(ctx());
      expect(relays).toHaveLength(2);
      expect(relays[1]!.connect).toHaveBeenCalledOnce();
      expect(_getState()).toBe("started");
  });

  test("stopping while identity is pending releases pair without affecting the next start", async () => {
    let resolveOldIdentity!: (keypair: { publicKey: Uint8Array; secretKey: Uint8Array }) => void;
    nextIdentity = () => new Promise((resolve) => { resolveOldIdentity = resolve; });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: { getSessionId: () => "session-identity-stop", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-identity-stop" } });
      const pairContext = ctx();
      const pairPromise = pi.commands.get("pi-reach pair")!("", pairContext);
      expect(relays).toHaveLength(0);

      await pi.commands.get("pi-reach stop")!("", ctx());
      await pairPromise;

      expect(pi.sent.some((message) => (message as { customType?: string }).customType === "pi-reach:pair-code")).toBe(false);
      expect(pairContext.ui.notify).toHaveBeenCalledWith("[pi-reach] Pair requires a Relay connection; current state: disconnected.", "warning");

      nextIdentity = null;
      await _connectForTest(ctx());
      expect(relays).toHaveLength(1);
      const newPublicKey = _getCachedPublicKeyForTest();

      resolveOldIdentity({ publicKey: new Uint8Array(32).fill(2), secretKey: new Uint8Array(32).fill(3) });
      await Promise.resolve();
      await Promise.resolve();
      expect(_getCachedPublicKeyForTest()).toBe(newPublicKey);
      expect(relays).toHaveLength(1);
      expect(_getState()).toBe("started");
  });

  test("stopping while host options are pending prevents the old Relay client", async () => {
    let resolvePeers!: (peers: OwnerRecord[]) => void;
    nextPeerList = () => new Promise((resolve) => { resolvePeers = resolve; });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: { getSessionId: () => "session-options-stop", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-options-stop" } });
      await vi.waitFor(() => expect(listPeers).toHaveBeenCalledOnce());
      expect(relays).toHaveLength(0);
      const pairContext = ctx();
      const pairPromise = pi.commands.get("pi-reach pair")!("", pairContext);

      await pi.commands.get("pi-reach stop")!("", ctx());
      await pairPromise;

      expect(pi.sent.some((message) => (message as { customType?: string }).customType === "pi-reach:pair-code")).toBe(false);
      expect(pairContext.ui.notify).toHaveBeenCalledWith("[pi-reach] Pair requires a Relay connection; current state: disconnected.", "warning");

      resolvePeers([]);
      await Promise.resolve();
      await Promise.resolve();
      expect(relays).toHaveLength(0);

      nextPeerList = null;
      await _connectForTest(ctx());
      expect(relays).toHaveLength(1);
      expect(relays[0]!.connect).toHaveBeenCalledOnce();
      expect(_getState()).toBe("started");
  });

  test("stopping a pending background reconnect closes its candidate without scheduling another retry", async () => {
    vi.useFakeTimers();
    try {
      await _connectForTest(ctx());
      nextRelayConnect = () => new Promise<void>(() => undefined);
      relays[0]!.emit("close");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(relays).toHaveLength(2);
      expect(relays[1]!.connect).toHaveBeenCalledOnce();
      expect(relays[1]!.listenerCount("message")).toBe(0);
      await _stopForTest(ctx());
      await Promise.resolve();

      expect(relays[1]!.close).toHaveBeenCalledOnce();
      expect(_hasPendingReconnect()).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(relays).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("stopping during background reconnect options does not create a candidate", async () => {
    vi.useFakeTimers();
    try {
      await _connectForTest(ctx());
      listPeers.mockClear();
      let resolvePeers!: (peers: OwnerRecord[]) => void;
      nextPeerList = () => new Promise((resolve) => { resolvePeers = resolve; });
      relays[0]!.emit("close");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(listPeers).toHaveBeenCalledOnce();
      expect(relays).toHaveLength(1);
      await _stopForTest(ctx());
      resolvePeers([]);
      await Promise.resolve();
      await Promise.resolve();

      expect(relays).toHaveLength(1);
      expect(_hasPendingReconnect()).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(relays).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("republishes the active pairing offer after Relay reconnect", async () => {
    vi.useFakeTimers();
    try {
      const pi = makePi();
      (extension as ExtensionFactory)(pi);
      pi.handlers.get("session_start")!({ reason: "startup" }, { ...ctx(), sessionManager: SessionManager.inMemory(process.cwd()) });
      await _connectForTest(ctx());

      const pairContext = ctx();
      await pi.commands.get("pi-reach pair")!("", pairContext);
      const firstRelay = relays[0]!;
      const firstOffer = firstRelay.sendControl.mock.calls.find(([frame]) => (frame as { type?: string }).type === "pairing_offer")?.[0];
      expect(firstOffer).toEqual(expect.objectContaining({
        type: "pairing_offer",
        code: "ABCD2345",
        endpoint_id: processEndpointIdentity().endpointId,
        runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
        expires_at: expect.any(Number),
      }));

      firstRelay.emit("close");
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(relays).toHaveLength(2));
      const reconnectedRelay = relays[1]!;
      await vi.waitFor(() => expect(reconnectedRelay.sendControl).toHaveBeenCalledWith(firstOffer));
    } finally {
      vi.useRealTimers();
    }
  });

  test("repeated start reports background reconnect without creating another Relay client", async () => {
    await _connectForTest(ctx());
    relays[0]!.emit("close");
    const retryContext = ctx();

    await _connectForTest(retryContext);

    expect(retryContext.ui.notify).toHaveBeenCalledWith("[pi-reach] Relay is reconnecting in background.", "warning");
    expect(retryContext.ui.notify).not.toHaveBeenCalledWith("[pi-reach] Already connected.", "warning");
    expect(relays).toHaveLength(1);
    expect(_hasPendingReconnect()).toBe(true);
    await _stopForTest(ctx());
  });

  test("does not generate a pairing QR after the socket stops being open", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")!({ reason: "startup" }, { ...ctx(), sessionManager: SessionManager.inMemory(process.cwd()) });
    await _connectForTest(ctx());
    relays[0]!.readyState = 3;
    const pairContext = ctx();

    await pi.commands.get("pi-reach pair")!("", pairContext);

    expect(pi.sent.some((message) => (message as { customType?: string }).customType === "pi-reach:pair-code")).toBe(false);
    expect(pairContext.ui.notify).toHaveBeenCalledWith(
      "[pi-reach] Pair requires a Relay connection; current state: reconnecting.",
      "warning",
    );
  });

  test("pairing trusts relay-injected source_owner_id and targets its response", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = SessionManager.inMemory(process.cwd());
    manager.appendSessionInfo("  Pairing session  ");
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P1", code: "ABCD2345", device_name: "phone" }));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    expect(owners).toEqual([expect.objectContaining({ remote_epk: sourceOwner(), name: "phone" })]);
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as Record<string, string>;
    expect(outbound.target_owner_id).toBe(sourceOwner());
    expect(outbound.source_owner_id).toBeUndefined();
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({
      type: "pair_ok",
      harness: { name: "Pi coding agent", version: packageVersion },
      session_name: "Pairing session",
      endpoint_id: processEndpointIdentity().endpointId,
    });
  });

  test("hides the pairing QR once its code is paired", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: SessionManager.inMemory(process.cwd()) });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    const pairContext = ctx();
    await pi.commands.get("pi-reach pair")!("", pairContext);

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P-hide", code: "ABCD2345", device_name: "phone" }));

    await vi.waitFor(() => expect(pairContext.ui.setWidget).toHaveBeenLastCalledWith("pi-reach-pair-code", undefined));
    expect(pairContext.ui.notify).toHaveBeenCalledWith("[pi-reach] Paired: phone", "info");
  });

  test("stopping the endpoint hides a pending pairing QR", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: SessionManager.inMemory(process.cwd()) });
    await _connectForTest(ctx());
    const pairContext = ctx();
    await pi.commands.get("pi-reach pair")!("", pairContext);

    await pi.commands.get("pi-reach stop")!("", pairContext);

    expect(pairContext.ui.setWidget).toHaveBeenLastCalledWith("pi-reach-pair-code", undefined);
    expect(pairContext.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Pairing code expired"), "info");
  });

  test("rolls back and leaves the request retryable when Relay rejects the ACL update", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.sendControl.mockClear();
    relay.sendControl.mockReturnValueOnce(false);

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P-acl-failed", code: "ABCD2345", device_name: "phone" }));

    await vi.waitFor(() => expect(conditionalRollbackPeer).toHaveBeenCalledOnce());
    expect(owners).toEqual([]);
    expect(pairingTokenState.released).toBe(true);
    expect(pairingTokenState.completion).toBeNull();
    expect(relay.send).not.toHaveBeenCalled();
    expect(relay.sendControl).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "endpoint_update",
      authorized_owner_ids: [],
    }));
  });

  test("replays pair_ok for the same Owner request after the first send fails", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.send.mockImplementationOnce(() => { throw new Error("pair_ok dropped"); });
    const request = { protocol_version: 2 as const, type: "pair_request" as const, id: "P-retry", code: "ABCD2345", device_name: "phone" };

    relay.emit("message", inbound(processEndpointIdentity(), request));
    await vi.waitFor(() => expect(addPeer).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(pairingTokenState.completion).not.toBeNull());
    relay.emit("message", inbound(processEndpointIdentity(), request));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalledTimes(2));

    expect(addPeer).toHaveBeenCalledOnce();
    const replay = JSON.parse(relay.send.mock.calls[1]![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(replay.ct, "base64").toString("utf8"))).toMatchObject({ type: "pair_ok", in_reply_to: "P-retry" });
  });

  test("replays pair_ok without replacing an active Owner session binding", async () => {
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    const request = { protocol_version: 2 as const, type: "pair_request" as const, id: "P-active-replay", code: "ABCD2345", device_name: "phone" };

    relay.emit("message", inbound(processEndpointIdentity(), request));
    await vi.waitFor(() => expect(pairingTokenState.completion).not.toBeNull());
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-active", channel_id: "channel-active" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalledTimes(3));
    const ready = readyFrame(relay);
    relay.emit("message", inbound(processEndpointIdentity(), request));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalledTimes(4));
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "ping", id: "ping-after-replay", channel_id: "channel-active", session_id: ready.session_id, leaf_id: ready.leaf_id }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalledTimes(5));

    const frames = relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from((JSON.parse(line) as { ct: string }).ct, "base64").toString("utf8")));
    expect(frames[2]).toMatchObject({ type: "queued_message_state", items: [] });
    expect(frames[3]).toMatchObject({ type: "pair_ok", in_reply_to: "P-active-replay" });
    expect(frames[4]).toMatchObject({ type: "pong", in_reply_to: "ping-after-replay" });
  });

  test("rolls back a pending pairing write when its Relay lifecycle closes", async () => {
    let releaseAddPeer!: () => void;
    nextAddPeer = () => new Promise<void>((resolve) => { releaseAddPeer = resolve; });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P-pending", code: "ABCD2345", device_name: "phone" }));
    await vi.waitFor(() => expect(addPeer).toHaveBeenCalledOnce());
    relay.readyState = 3;
    relay.emit("close");
    releaseAddPeer();

    await vi.waitFor(() => expect(conditionalRollbackPeer).toHaveBeenCalledOnce());
    expect(owners).toEqual([]);
    expect(pairingTokenState.released).toBe(true);
  });

  test("refreshes the current Relay ACL after an old Relay attempt rolls back", async () => {
    vi.useFakeTimers();
    try {
      let releaseAddPeer!: () => void;
      nextAddPeer = () => new Promise<void>((resolve) => { releaseAddPeer = resolve; });
      const pi = makePi();
      (extension as ExtensionFactory)(pi);
      const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
      pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
      await _connectForTest(ctx());
      const oldRelay = relays[0]!;

      oldRelay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P-old-relay", code: "ABCD2345", device_name: "phone" }));
      await vi.waitFor(() => expect(addPeer).toHaveBeenCalledOnce());
      oldRelay.readyState = 3;
      oldRelay.emit("close");
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(relays).toHaveLength(2));
      const currentRelay = relays[1]!;
      // Model Relay B observing the transient addPeer write before the old
      // attempt resumes and compensates it.
      owners.push({ name: "phone", remote_epk: sourceOwner(), paired_at: "transient" });
      currentRelay.sendControl.mockClear();

      releaseAddPeer();

      await vi.waitFor(() => expect(conditionalRollbackPeer).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(currentRelay.sendControl).toHaveBeenCalledWith(expect.objectContaining({
        type: "endpoint_update",
        authorized_owner_ids: [],
      })));
      expect(owners).toEqual([]);
      expect(oldRelay.sendControl).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("rolls back a pending write when a new QR invalidates its reservation", async () => {
    let releaseAddPeer!: () => void;
    nextAddPeer = () => new Promise<void>((resolve) => { releaseAddPeer = resolve; });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P-old-qr", code: "ABCD2345", device_name: "phone" }));
    await vi.waitFor(() => expect(addPeer).toHaveBeenCalledOnce());
    pairingTokenState.reservation = Object.freeze({ code: "NEWC0DE1", ownerId: sourceOwner(), requestId: "P-new-qr" });
    releaseAddPeer();

    await vi.waitFor(() => expect(conditionalRollbackPeer).toHaveBeenCalledOnce());
    expect(owners).toEqual([]);
    expect(relay.send).not.toHaveBeenCalled();
  });

  test("does not let a competing request replace the reserved Owner binding", async () => {
    let releaseAddPeer!: () => void;
    nextAddPeer = () => new Promise<void>((resolve) => { releaseAddPeer = resolve; });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    const ownerA = sourceOwner();
    const ownerB = ownerId(8);

    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P-owner-a", code: "ABCD2345", device_name: "owner-a" }, "pairing", ownerA));
    await vi.waitFor(() => expect(addPeer).toHaveBeenCalledOnce());
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "pair_request", id: "P-owner-b", code: "ABCD2345", device_name: "owner-b" }, "pairing", ownerB));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalledOnce());
    releaseAddPeer();
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalledTimes(2));

    const frames = relay.send.mock.calls.map(([line]) => {
      const outbound = JSON.parse(line) as { target_owner_id: string; ct: string };
      return { ownerId: outbound.target_owner_id, frame: decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8")) };
    });
    expect(frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerId: ownerB, frame: expect.objectContaining({ type: "pair_error", code: "token_consumed" }) }),
      expect.objectContaining({ ownerId: ownerA, frame: expect.objectContaining({ type: "pair_ok", in_reply_to: "P-owner-a" }) }),
    ]));
  });

  test("rejects a route without Relay-provided source_owner_id", async () => {
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", JSON.stringify({
      type: "route", purpose: "pairing", device_id: Buffer.alloc(32, 1).toString("base64"),
      endpoint_id: processEndpointIdentity().endpointId, runtime_instance_id: processEndpointIdentity().runtimeInstanceId,
      ct: Buffer.from(JSON.stringify({ protocol_version: 2, type: "pair_request", id: "P1", code: "ABCD2345", device_name: "phone" })).toString("base64"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relay.send).not.toHaveBeenCalled();
  });

  test("revoke sends peer_stop only to the target before detaching and updating Relay ACL", async () => {
    const ownerB = sourceOwner();
    const ownerC = ownerId(8);
    owners.push(
      { name: "owner-b", remote_epk: ownerB, paired_at: "now" },
      { name: "owner-c", remote_epk: ownerC, paired_at: "now" },
    );
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-revoke", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-revoke" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-b", channel_id: "channel-b" }, "session", ownerB));
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-c", channel_id: "channel-c" }, "session", ownerC));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalledTimes(4));
    const readyFrames = relay.send.mock.calls.map(([line]) => {
      const outbound = JSON.parse(line) as { target_owner_id: string; ct: string };
      return { ownerId: outbound.target_owner_id, frame: decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8")) };
    });
    const readyB = readyFrames.find(({ ownerId: target, frame }) => target === ownerB && frame.type === "session_ready")?.frame;
    const readyC = readyFrames.find(({ ownerId: target, frame }) => target === ownerC && frame.type === "session_ready")?.frame;
    if (!readyB || !readyC || readyB.type !== "session_ready" || readyC.type !== "session_ready") throw new Error("expected owner sessions");
    relay.send.mockClear();
    relay.sendControl.mockClear();
    const listenersBeforeRevoke = relay.listenerCount("message");
    let listenersAtBye = -1;
    let listenersAtAclUpdate = -1;
    relay.send.mockImplementationOnce(() => { listenersAtBye = relay.listenerCount("message"); });
    relay.sendControl.mockImplementationOnce(() => { listenersAtAclUpdate = relay.listenerCount("message"); });
    await pi.commands.get("pi-reach revoke")!(ownerB.slice(0, 8), ctx());

    const byeOutbound = JSON.parse(relay.send.mock.calls[0]![0]) as { target_owner_id: string; ct: string };
    expect(byeOutbound.target_owner_id).toBe(ownerB);
    expect(decodeServerFrameV2(Buffer.from(byeOutbound.ct, "base64").toString("utf8"))).toMatchObject({
      type: "bye", session_id: "session-revoke", leaf_id: readyB.leaf_id, reason: "peer_stop",
    });
    expect(relay.send.mock.calls).toHaveLength(1);
    expect(listenersAtBye).toBe(listenersBeforeRevoke);
    expect(listenersAtAclUpdate).toBe(listenersBeforeRevoke - 1);
    expect(relay.listenerCount("message")).toBe(listenersBeforeRevoke - 1);
    expect(relay.send.mock.invocationCallOrder[0]).toBeLessThan(relay.sendControl.mock.invocationCallOrder[0]!);
    expect(relay.sendControl).toHaveBeenCalledWith(expect.objectContaining({
      type: "endpoint_update", authorized_owner_ids: [ownerC],
    }));

    const survivorCursor = relay.send.mock.calls.length;
    relay.emit("message", inbound(processEndpointIdentity(), {
      protocol_version: 2, type: "ping", id: "ping-c", channel_id: "channel-c", session_id: readyC.session_id, leaf_id: readyC.leaf_id,
    }, "session", ownerC));
    await vi.waitFor(() => expect(relay.send.mock.calls).toHaveLength(survivorCursor + 1));
    const survivorOutbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { target_owner_id: string; ct: string };
    expect(survivorOutbound.target_owner_id).toBe(ownerC);
    expect(decodeServerFrameV2(Buffer.from(survivorOutbound.ct, "base64").toString("utf8"))).toMatchObject({ type: "pong", in_reply_to: "ping-c" });
  });

  test("revoke keeps the binding session id during a session replacement window", async () => {
    const ownerB = sourceOwner();
    owners.push({ name: "owner-b", remote_epk: ownerB, paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-before-replacement", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-before-replacement" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-b", channel_id: "channel-b" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const ready = readyFrame(relay);
    relay.send.mockClear();

    pi.handlers.get("session_shutdown")?.({ reason: "new" });
    await pi.commands.get("pi-reach revoke")!(ownerB.slice(0, 8), ctx());

    const byeOutbound = JSON.parse(relay.send.mock.calls[0]![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(byeOutbound.ct, "base64").toString("utf8"))).toMatchObject({
      type: "bye",
      session_id: "session-before-replacement",
      leaf_id: ready.leaf_id,
      reason: "peer_stop",
    });
  });

  test("revoke best-effort bye does not block detach or Relay ACL update", async () => {
    const ownerB = sourceOwner();
    owners.push({ name: "owner-b", remote_epk: ownerB, paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-revoke", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-revoke" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-b", channel_id: "channel-b" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const listenersBeforeRevoke = relay.listenerCount("message");
    relay.send.mockImplementationOnce(() => { throw new Error("send unavailable"); });
    relay.sendControl.mockClear();
    await pi.commands.get("pi-reach revoke")!(ownerB.slice(0, 8), ctx());

    expect(relay.listenerCount("message")).toBe(listenersBeforeRevoke - 1);
    expect(relay.sendControl).toHaveBeenCalledWith(expect.objectContaining({ type: "endpoint_update", authorized_owner_ids: [] }));
    expect(owners).toEqual([]);
  });

  test("routes remote compaction accepted and final callback responses without broadcasting request results", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = SessionManager.inMemory(process.cwd());
    let options: { onComplete?: (result: unknown) => void; onError?: (error: Error) => void } | undefined;
    const context = { ...ctx(), sessionManager: manager, compact: vi.fn((value) => { options = value; }) };
    pi.handlers.get("session_start")?.({}, context);
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello", channel_id: "channel" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const ready = readyFrame(relay);
    const frames = () => relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from((JSON.parse(line) as { ct: string }).ct, "base64")));
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_compact", id: "compact-remote", channel_id: "channel", session_id: ready.session_id, leaf_id: ready.leaf_id }, "session"));
    expect(frames()).toEqual([{ protocol_version: 2, type: "action_ok", target_channel_id: "channel", in_reply_to: "compact-remote", action: "session_compact", phase: "accepted" }]);
    options?.onComplete?.({});
    options?.onError?.(new Error("private body"));
    expect(frames()).toHaveLength(2);
    expect(frames()[1]).toMatchObject({ target_channel_id: "channel", in_reply_to: "compact-remote", phase: "completed" });
    expect(frames().some((frame) => frame.type === "timeline_event" || frame.type === "compaction_activity")).toBe(false);
  });

  test("broadcasts public compaction activity to owners while publishing the summary only on timeline", async () => {
    const ownerB = ownerId(8);
    owners.push({ name: "owner-a", remote_epk: sourceOwner(), paired_at: "now" }, { name: "owner-b", remote_epk: ownerB, paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const manager = SessionManager.inMemory(process.cwd());
    const first = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
    const context = { ...ctx(), sessionManager: manager };
    pi.handlers.get("session_start")?.({}, context);
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-a", channel_id: "a" }, "session"));
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-b", channel_id: "b" }, "session", ownerB));
    await vi.waitFor(() => expect(_getActivePeerCountForTest()).toBe(2));
    relay.send.mockClear();
    for (const reason of ["manual", "threshold", "overflow"]) {
      pi.handlers.get("session_before_compact")?.({ reason }, context);
      pi.handlers.get("session_compact_failed")?.({ reason, aborted: false, errorMessage: "private failure body" }, context);
      pi.handlers.get("session_compact_failed")?.({ reason, aborted: true, errorMessage: "private failure body" }, context);
    }
    const entryId = manager.appendCompaction("formal summary", first, 100);
    const entry = manager.getBranch().find((candidate) => candidate.id === entryId)!;
    pi.handlers.get("session_compact")?.({ reason: "manual", compactionEntry: entry }, context);
    pi.handlers.get("session_compact")?.({ reason: "manual", compactionEntry: entry }, context);
    const frames = relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from((JSON.parse(line) as { ct: string }).ct, "base64")));
    for (const reason of ["manual", "threshold", "overflow"]) {
      for (const status of ["running", "failed", "cancelled"]) {
        expect(frames.filter((frame) => frame.type === "compaction_activity" && frame.reason === reason && frame.status === status)).toHaveLength(2);
      }
    }
    const activity = frames.filter((frame) => frame.type === "compaction_activity");
    expect(activity.every((frame) => !("in_reply_to" in frame) && !("target_channel_id" in frame) && !("error" in frame) && !("summary" in frame))).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("private failure body");
    expect(frames.filter((frame) => frame.type === "timeline_event" && frame.event.kind === "compaction")).toHaveLength(2);
    expect(frames.some((frame) => frame.type === "action_ok" || frame.type === "action_error")).toBe(false);
  });

  test("routes session_new through the internal command bridge and uses its command ctx", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockResolvedValue(undefined);
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), {
      protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1",
    }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const ready = readyFrame(relay);
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), {
      protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", session_id: ready.session_id, leaf_id: ready.leaf_id,
    }, "session"));
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalled());
    const [content, options] = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(content).toMatch(/^\/pi-reach internal-session-new [0-9a-f-]{36}$/);
    expect(options).toEqual({ expandPromptTemplates: true });

    const token = (content as string).split(" ")[2]!;
    const newManager = { ...manager, getSessionId: () => "session-2", getLeafId: () => "session-2" };
    const commandCtx = {
      ...ctx(),
      newSession: vi.fn(async (options?: { withSession?: (fresh: unknown) => Promise<void> }) => {
        expect(pi.handlers.get("session_before_switch")?.({ reason: "new" })).toBeUndefined();
        expect(pi.handlers.get("session_before_switch")?.({ reason: "resume" })).toEqual({ cancel: true });
        expect(pi.handlers.get("session_before_switch")?.({ reason: "new" })).toEqual({ cancel: true });
        expect(pi.handlers.get("session_before_fork")?.({ entryId: "entry", position: "before" })).toEqual({ cancel: true });
        pi.handlers.get("session_shutdown")?.({ reason: "new" });
        pi.handlers.get("session_start")?.({ reason: "new" }, { ...ctx(), sessionManager: newManager });
        await options?.withSession?.({ ...ctx(), sessionManager: newManager, newSession: vi.fn() });
        return { cancelled: false };
      }),
    };
    await pi.commands.get("pi-reach")?.(`internal-session-new ${token}`, commandCtx);
    expect(commandCtx.newSession).toHaveBeenCalledTimes(1);
    expect(relay.close).not.toHaveBeenCalled();
    const frames = relay.send.mock.calls.map(([line]) => {
      const outbound = JSON.parse(line) as { ct: string };
      return decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"));
    });
    expect(frames.at(-2)).toMatchObject({ type: "action_ok", in_reply_to: "new-1", action: "session_new", session_id: "session-2" });
    expect(frames.at(-1)).toMatchObject({ type: "bye", session_id: "session-1", reason: "session_replaced" });
    expect(pi.handlers.get("session_before_switch")?.({ reason: "resume" })).toBeUndefined();
    expect(pi.handlers.get("session_before_fork")?.({ entryId: "entry", position: "before" })).toBeUndefined();
  });

  test("a local session replacement keeps Relay alive and sends bye after the new session is ready", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (extension as ExtensionFactory)(pi);
    const oldManager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    const newManager = { ...oldManager, getSessionId: () => "session-2", getLeafId: () => "session-2" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: oldManager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    relay.send.mockClear();
    pi.handlers.get("session_shutdown")?.({ reason: "new" });
    expect(relay.send).not.toHaveBeenCalled();
    const replacement = makePi();
    (extension as ExtensionFactory)(replacement);
    replacement.handlers.get("session_start")?.({ reason: "new" }, { ...ctx(), sessionManager: newManager });
    expect(relay.close).not.toHaveBeenCalled();
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({ type: "bye", session_id: "session-1", reason: "session_replaced" });
  });

  test("session_new bridge returns action_error when dispatch fails", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockRejectedValue(new Error("dispatch unavailable"));
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const ready = readyFrame(relay);
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", session_id: ready.session_id, leaf_id: ready.leaf_id }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({
      type: "action_error", in_reply_to: "new-1", action: "session_new", error: "session replacement dispatch failed",
    });
  });

  test("stopping cancels a dispatched session_new before closing Relay", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockResolvedValue(undefined);
    (extension as ExtensionFactory)(pi);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const ready = readyFrame(relay);
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", session_id: ready.session_id, leaf_id: ready.leaf_id }, "session"));
    await vi.waitFor(() => expect(pi.sendUserMessage).toHaveBeenCalled());
    await _stopForTest(ctx());
    const frames = relay.send.mock.calls.map(([line]) => decodeServerFrameV2(Buffer.from((JSON.parse(line) as { ct: string }).ct, "base64").toString("utf8")));
    expect(frames[0]).toMatchObject({ type: "action_error", in_reply_to: "new-1", error: "session replacement cancelled because the endpoint closed" });
    expect(frames[1]).toMatchObject({ type: "bye", reason: "peer_stop" });
    expect(relay.close).toHaveBeenCalledTimes(1);
  });

  test("session_new bridge times out without an internal command invocation", async () => {
    owners.push({ name: "owner", remote_epk: sourceOwner(), paired_at: "now" });
    const pi = makePi();
    (pi as { sendUserMessage?: unknown }).sendUserMessage = vi.fn().mockResolvedValue(undefined);
    (extension as ExtensionFactory)(pi);
    _setSessionNewBridgeTimeoutForTest(5);
    const manager = { getSessionId: () => "session-1", getBranch: () => [], appendCustomEntry: vi.fn(), getLeafId: () => "session-1" };
    pi.handlers.get("session_start")?.({}, { ...ctx(), sessionManager: manager });
    await _connectForTest(ctx());
    const relay = relays.at(-1)!;
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_hello", id: "hello-1", channel_id: "channel-1" }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const ready = readyFrame(relay);
    relay.send.mockClear();
    relay.emit("message", inbound(processEndpointIdentity(), { protocol_version: 2, type: "session_new", id: "new-1", channel_id: "channel-1", session_id: ready.session_id, leaf_id: ready.leaf_id }, "session"));
    await vi.waitFor(() => expect(relay.send).toHaveBeenCalled());
    const outbound = JSON.parse(relay.send.mock.calls.at(-1)![0]) as { ct: string };
    expect(decodeServerFrameV2(Buffer.from(outbound.ct, "base64").toString("utf8"))).toMatchObject({
      type: "action_error", in_reply_to: "new-1", action: "session_new", error: "session replacement dispatch timed out",
    });
  });
});
