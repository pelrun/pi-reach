import { PAIRING_INVITE_TTL_MS, PAIR_TTL_MAX_MS, PAIR_TTL_MIN_MS, type RouteFrame } from "@pi-reach/protocol/outer";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { DiscoveryCapacityError, discoveryBaselineBytes, endpointDiscoveryBytes } from "./discovery-budget.js";
import { PeerRegistry, type Outbound } from "./registry.js";
import { TransportPool, type TransportSocket } from "./transport.js";
import { PAIRING_RESOLVE_LIMIT, PAIRING_RESOLVE_WINDOW_MS, stringifyWire, type HostHello } from "./wire.js";

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const RUNTIME_A = "22222222-2222-4222-8222-222222222222";
const RUNTIME_B = "33333333-3333-4333-8333-333333333333";
const identity = (byte: number) => Buffer.alloc(32, byte).toString("base64");

class BufferedFakeSocket implements TransportSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  terminated = 0;

  send(text: string, _callback: (error?: Error) => void): void {
    this.bufferedAmount += Buffer.byteLength(text, "utf8");
  }

  terminate(): void {
    this.terminated += 1;
    this.readyState = WebSocket.CLOSED;
  }
}

function sink(): Outbound & { frames: Array<Record<string, unknown>>; lines: string[]; open: boolean } {
  const frames: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const state = {
    frames,
    lines,
    open: true,
    send: (line: string) => { lines.push(line); frames.push(JSON.parse(line) as Record<string, unknown>); return true; },
    isOpen: () => state.open,
  };
  return state;
}

function host(deviceId: string, runtimeInstanceId: string, owners: string[]): HostHello {
  return {
    role: "host",
    deviceId,
    endpointId: ENDPOINT_ID,
    runtimeInstanceId,
    metadata: { kind: "daemon", name: runtimeInstanceId },
    authorizedOwnerIds: new Set(owners),
  };
}

function route(deviceId: string, runtimeInstanceId: string, purpose: "session" | "pairing"): RouteFrame {
  return { type: "route", purpose, device_id: deviceId, endpoint_id: ENDPOINT_ID, runtime_instance_id: runtimeInstanceId, ct: "opaque" };
}

describe("PeerRegistry", () => {
  it("keeps the new runtime authoritative through takeover and ACL updates", () => {
    const registry = new PeerRegistry(() => 1_000);
    const device = identity(1);
    const owner = identity(2);
    const ownerSink = sink();
    const ownerConn = registry.registerOwner(owner, ownerSink);
    registry.subscribeEndpoints(owner, ownerConn, [device]);
    expect(ownerSink.frames.pop()).toEqual({ type: "endpoints", device_id: device, endpoints: [] });

    const hostA = sink();
    const connA = registry.registerHost(host(device, RUNTIME_A, [owner]), hostA);
    expect(ownerSink.frames.pop()).toMatchObject({ type: "endpoint_announced", runtime_instance_id: RUNTIME_A });

    const hostB = sink();
    const connB = registry.registerHost(host(device, RUNTIME_B, [owner]), hostB);
    expect(ownerSink.frames.pop()).toMatchObject({ type: "endpoint_updated", runtime_instance_id: RUNTIME_B });
    registry.unregisterHost(device, ENDPOINT_ID, connA);
    expect(ownerSink.frames).toHaveLength(0);
    expect(registry.routeFromOwner(owner, ownerConn, route(device, RUNTIME_A, "session"))).toBe("stale");
    expect(registry.routeFromOwner(owner, ownerConn, route(device, RUNTIME_B, "session"))).toBe("delivered");
    expect(hostB.frames.pop()).toMatchObject({ source_owner_id: owner, ct: "opaque" });

    registry.updateHost(device, ENDPOINT_ID, connB, { authorizedOwnerIds: new Set() });
    expect(ownerSink.frames.pop()).toEqual({
      type: "endpoint_ended", device_id: device, endpoint_id: ENDPOINT_ID, runtime_instance_id: RUNTIME_B,
    });
    expect(registry.routeFromOwner(owner, ownerConn, route(device, RUNTIME_B, "session"))).toBe("unauthorized");
    expect(registry.routeFromOwner(owner, ownerConn, route(device, RUNTIME_B, "pairing"))).toBe("delivered");
  });

  it("treats a host whose socket is no longer open as disconnected before it is unregistered", () => {
    const registry = new PeerRegistry(() => 10_000);
    const device = identity(3);
    const owner = identity(4);
    const ownerSink = sink();
    const ownerConn = registry.registerOwner(owner, ownerSink);
    const hostSink = sink();
    const hostConn = registry.registerHost(host(device, RUNTIME_A, []), hostSink);
    expect(registry.publishPairingOffer(device, ENDPOINT_ID, hostConn, {
      code: "ABC12345", endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: 20_000,
    })).toBe(true);

    hostSink.open = false;
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "closing", code: "ABC12345" })).toBe("unknown_code");
    expect(ownerSink.frames.pop()).toMatchObject({ in_reply_to: "closing", reason: "unknown_code" });
    hostSink.open = true;
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "again", code: "ABC12345" })).toBe("unknown_code");
  });

  it("bounds pairing resolution per owner connection and preserves first expiry result", () => {
    let now = 10_000;
    const registry = new PeerRegistry(() => now);
    const device = identity(3);
    const owner = identity(4);
    const ownerSink = sink();
    const ownerConn = registry.registerOwner(owner, ownerSink);
    const hostConn = registry.registerHost(host(device, RUNTIME_A, []), sink());

    expect(registry.publishPairingOffer(device, ENDPOINT_ID, hostConn, {
      code: "ABC12345", endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: now,
    })).toBe(true);
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "expired", code: "ABC12345" })).toBe("expired_code");
    expect(ownerSink.frames.pop()).toMatchObject({ in_reply_to: "expired", reason: "expired_code" });

    for (let attempt = 1; attempt < PAIRING_RESOLVE_LIMIT; attempt += 1) {
      expect(registry.resolvePairingCode(owner, ownerConn, { requestId: `unknown-${attempt}`, code: "UNKNOWN1" })).toBe("unknown_code");
    }
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "limited", code: "UNKNOWN1" })).toBe("rate_limited");
    expect(ownerSink.frames.pop()).toMatchObject({ in_reply_to: "limited", reason: "rate_limited" });

    now += PAIRING_RESOLVE_WINDOW_MS;
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "reset", code: "UNKNOWN1" })).toBe("unknown_code");
  });

  it("caps an over-bound pairing offer at the relay window and honours an earlier host expiry", () => {
    let now = 20_000;
    const registry = new PeerRegistry(() => now);
    const device = identity(5);
    const owner = identity(6);
    const ownerSink = sink();
    const ownerConn = registry.registerOwner(owner, ownerSink);
    const hostConn = registry.registerHost(host(device, RUNTIME_A, []), sink());

    for (const [code, ttlMs] of [
      ["AAAA0001", PAIRING_INVITE_TTL_MS],
      ["AAAA0002", PAIR_TTL_MIN_MS],
      ["AAAA0003", PAIR_TTL_MAX_MS],
    ] as const) {
      expect(registry.publishPairingOffer(device, ENDPOINT_ID, hostConn, {
        code, endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: now + ttlMs,
      })).toBe(true);
    }

    // 超出上限的时间戳不被拒绝，而是按 Relay 接收窗口到期。
    expect(registry.publishPairingOffer(device, ENDPOINT_ID, hostConn, {
      code: "AAAA0004", endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: now + PAIR_TTL_MAX_MS + 86_400_000,
    })).toBe(true);
    now += PAIR_TTL_MAX_MS - 1;
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "within", code: "AAAA0004" })).toBe("resolved");
    ownerSink.frames.pop();

    // 更早的主机时间戳先生效；已过去的时间戳立即到期。
    expect(registry.publishPairingOffer(device, ENDPOINT_ID, hostConn, {
      code: "AAAA0005", endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: now + 30_000,
    })).toBe(true);
    now += 30_000;
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "host-expired", code: "AAAA0005" })).toBe("expired_code");
    ownerSink.frames.pop();
    expect(registry.publishPairingOffer(device, ENDPOINT_ID, hostConn, {
      code: "AAAA0006", endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: now - 1_000,
    })).toBe(true);
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "stale", code: "AAAA0006" })).toBe("expired_code");
  });

  it("keeps broadcasting when an earlier owner unregisters synchronously", () => {
    const registry = new PeerRegistry(() => 20_000);
    const device = identity(7);
    const ownerA = identity(8);
    const ownerB = identity(9);
    let ownerAConn = -1;
    let armed = false;
    const first: Outbound = {
      send: () => {
        if (armed) registry.unregisterOwner(ownerA, ownerAConn);
        return false;
      },
      isOpen: () => true,
    };
    ownerAConn = registry.registerOwner(ownerA, first);
    registry.subscribeEndpoints(ownerA, ownerAConn, [device]);
    const second = sink();
    const ownerBConn = registry.registerOwner(ownerB, second);
    registry.subscribeEndpoints(ownerB, ownerBConn, [device]);
    second.frames.length = 0;
    armed = true;

    registry.registerHost(host(device, RUNTIME_A, [ownerA, ownerB]), sink());
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0]).toMatchObject({ type: "endpoint_announced", device_id: device });
  });

  it("does not allow a pairing code collision to overwrite another host", () => {
    const registry = new PeerRegistry(() => 20_000);
    const firstDevice = identity(5);
    const secondDevice = identity(6);
    const first = registry.registerHost(host(firstDevice, RUNTIME_A, []), sink());
    const second = registry.registerHost(host(secondDevice, RUNTIME_A, []), sink());
    const offer = { code: "CODE2345", endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: 21_000 };
    expect(registry.publishPairingOffer(firstDevice, ENDPOINT_ID, first, offer)).toBe(true);
    expect(registry.publishPairingOffer(secondDevice, ENDPOINT_ID, second, offer)).toBe(false);
  });

  it("rejects registration and takeover before mutating endpoints or pairing offers", () => {
    const device = identity(10);
    const owner = identity(11);
    const initial = host(device, RUNTIME_A, [owner]);
    const initialBytes = endpointDiscoveryBytes(device, {
      endpoint_id: initial.endpointId, runtime_instance_id: initial.runtimeInstanceId, metadata: initial.metadata,
    });
    const maximum = Number(discoveryBaselineBytes(1) + initialBytes);
    const registry = new PeerRegistry(() => 20_000, { maxDiscoveryBytes: maximum, maxSubscriptions: 1 });
    const ownerSink = sink();
    const ownerConn = registry.registerOwner(owner, ownerSink);
    const conn = registry.registerHost(initial, sink());
    expect(registry.publishPairingOffer(device, ENDPOINT_ID, conn, {
      code: "KEEP2345", endpointId: ENDPOINT_ID, runtimeInstanceId: RUNTIME_A, expiresAt: 21_000,
    })).toBe(true);

    const oversizedTakeover = host(device, RUNTIME_B, [owner]);
    oversizedTakeover.metadata = { kind: "daemon", name: "超".repeat(20) };
    expect(() => registry.registerHost(oversizedTakeover, sink())).toThrow(DiscoveryCapacityError);
    expect(registry.isActiveHost(device, ENDPOINT_ID, conn)).toBe(true);
    expect(registry.resolvePairingCode(owner, ownerConn, { requestId: "kept", code: "KEEP2345" })).toBe("resolved");
    expect(registry.routeFromOwner(owner, ownerConn, route(device, RUNTIME_A, "session"))).toBe("delivered");
  });

  it("rejects an oversized update without partial metadata or ACL mutation", () => {
    const device = identity(12);
    const oldOwner = identity(13);
    const newOwner = identity(14);
    const initial = host(device, RUNTIME_A, [oldOwner]);
    const initialBytes = endpointDiscoveryBytes(device, {
      endpoint_id: initial.endpointId, runtime_instance_id: initial.runtimeInstanceId, metadata: initial.metadata,
    });
    const registry = new PeerRegistry(() => 20_000, {
      maxDiscoveryBytes: Number(discoveryBaselineBytes(1) + initialBytes), maxSubscriptions: 1,
    });
    const conn = registry.registerHost(initial, sink());
    expect(() => registry.updateHost(device, ENDPOINT_ID, conn, {
      metadata: { kind: "daemon", name: "超".repeat(20) }, authorizedOwnerIds: new Set([newOwner]),
    })).toThrow(DiscoveryCapacityError);
    const oldSink = sink();
    const oldConn = registry.registerOwner(oldOwner, oldSink);
    registry.subscribeEndpoints(oldOwner, oldConn, [device]);
    expect(oldSink.frames.at(-1)).toMatchObject({ endpoints: [{ metadata: initial.metadata }] });
    const newSink = sink();
    const newConn = registry.registerOwner(newOwner, newSink);
    registry.subscribeEndpoints(newOwner, newConn, [device]);
    expect(newSink.frames.at(-1)).toMatchObject({ endpoints: [] });
  });

  it("keeps budget accounting correct across stale unregister and synchronous replacement", () => {
    const device = identity(15);
    const owner = identity(16);
    const sample = host(device, RUNTIME_A, [owner]);
    const entryBytes = endpointDiscoveryBytes(device, {
      endpoint_id: sample.endpointId, runtime_instance_id: sample.runtimeInstanceId, metadata: sample.metadata,
    });
    const registry = new PeerRegistry(() => 20_000, {
      maxDiscoveryBytes: Number(discoveryBaselineBytes(1) + entryBytes), maxSubscriptions: 1,
    });
    const first = registry.registerHost(sample, sink());
    const secondHello = host(device, RUNTIME_B, [owner]);
    let armed = false;
    const ownerConn = registry.registerOwner(owner, {
      send: () => {
        if (armed) registry.unregisterHost(device, ENDPOINT_ID, first);
        return true;
      },
      isOpen: () => true,
    });
    registry.subscribeEndpoints(owner, ownerConn, [device]);
    armed = true;
    const second = registry.registerHost(secondHello, sink());
    registry.unregisterHost(device, ENDPOINT_ID, first);
    expect(registry.isActiveHost(device, ENDPOINT_ID, second)).toBe(true);
    registry.unregisterHost(device, ENDPOINT_ID, second);
    expect(() => registry.registerHost(sample, sink())).not.toThrow();
  });

  it("keeps a healthy bounded transport within budget for a complete subscription", () => {
    const owner = identity(21);
    const devices = [identity(22), identity(23), identity(24)];
    const hellos = devices.slice(0, 2).map((device, index) => host(device, index === 0 ? RUNTIME_A : RUNTIME_B, [owner]));
    const entryBytes = hellos.reduce((sum, hello) => sum + endpointDiscoveryBytes(hello.deviceId, {
      endpoint_id: hello.endpointId, runtime_instance_id: hello.runtimeInstanceId, metadata: hello.metadata,
    }), 0n);
    const maximum = discoveryBaselineBytes(devices.length) + entryBytes;
    const registry = new PeerRegistry(() => 20_000, { maxDiscoveryBytes: Number(maximum), maxSubscriptions: devices.length });
    for (const hello of hellos) registry.registerHost(hello, sink());
    const pool = new TransportPool({ maxBufferedBytes: Number(maximum), maxTotalBufferedBytes: Number(maximum) });
    const socket = new BufferedFakeSocket();
    let overflow = 0;
    const transport = pool.attach(socket, () => { overflow += 1; });
    const ownerConn = registry.registerOwner(owner, { send: (line) => transport.send(line), isOpen: () => transport.isOpen });
    expect(registry.subscribeEndpoints(owner, ownerConn, devices)).toBe(true);
    expect(overflow).toBe(0);
    expect(socket.terminated).toBe(0);
    expect(socket.bufferedAmount).toBeLessThanOrEqual(Number(maximum));
  });

  it("budgets complete multi-device snapshots including empty devices and allows ACL expansion", () => {
    const owner = identity(17);
    const devices = [identity(18), identity(19), identity(20)];
    const hellos = devices.slice(0, 2).map((device, index) => host(device, index === 0 ? RUNTIME_A : RUNTIME_B, []));
    const entryBytes = hellos.reduce((sum, hello) => sum + endpointDiscoveryBytes(hello.deviceId, {
      endpoint_id: hello.endpointId, runtime_instance_id: hello.runtimeInstanceId, metadata: hello.metadata,
    }), 0n);
    const maximum = discoveryBaselineBytes(devices.length) + entryBytes;
    const registry = new PeerRegistry(() => 20_000, { maxDiscoveryBytes: Number(maximum), maxSubscriptions: devices.length });
    const connections = hellos.map((hello) => registry.registerHost(hello, sink()));
    for (let index = 0; index < hellos.length; index += 1) {
      expect(registry.updateHost(hellos[index]!.deviceId, ENDPOINT_ID, connections[index]!, {
        authorizedOwnerIds: new Set([owner]),
      })).toBe(true);
    }
    const ownerSink = sink();
    const ownerConn = registry.registerOwner(owner, ownerSink);
    registry.subscribeEndpoints(owner, ownerConn, devices);
    const sentBytes = ownerSink.lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8"), 0);
    expect(sentBytes).toBeLessThanOrEqual(Number(maximum));
    expect(ownerSink.frames).toHaveLength(3);
    expect(ownerSink.frames.at(-1)).toEqual({ type: "endpoints", device_id: devices[2], endpoints: [] });
    expect(ownerSink.lines.every((line) => stringifyWire(JSON.parse(line)) === line)).toBe(true);
  });
});
