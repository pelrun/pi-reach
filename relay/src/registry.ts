import { PAIR_TTL_MAX_MS, type RouteFrame } from "@pi-reach/protocol/outer";

import { DEFAULT_RELAY_LIMITS } from "./config.js";
import { DiscoveryBudget } from "./discovery-budget.js";
import {
  compareExactInteger,
  PAIRING_RESOLVE_LIMIT,
  PAIRING_RESOLVE_WINDOW_MS,
  stringifyWire,
  type EndpointUpdate,
  type ExactInteger,
  type HostHello,
  type PairingOffer,
  type RelayEndpointMetadata,
  type ResolvePairingCode,
} from "./wire.js";

export type Outbound = { send(text: string): boolean; isOpen(): boolean };
export type RouteOutcome = "delivered" | "unauthorized" | "stale" | "unavailable";
export type PairingResolveOutcome = "resolved" | "unknown_code" | "expired_code" | "stale_target" | "rate_limited" | "stale_owner";

type RelayEndpointInfo = { endpoint_id: string; runtime_instance_id: string; metadata: RelayEndpointMetadata };
type HostConnection = {
  connId: number;
  runtimeInstanceId: string;
  metadata: RelayEndpointMetadata;
  authorizedOwnerIds: Set<string>;
  outbound: Outbound;
  discoveryBytes: bigint;
};
type OwnerConnection = {
  outbound: Outbound;
  subscribedDeviceIds: Set<string>;
  pairingResolveWindowStartedAt: number;
  pairingResolveCount: number;
};
type PairingOfferRecord = {
  deviceId: string;
  endpointId: string;
  runtimeInstanceId: string;
  connId: number;
  expiresAt: ExactInteger;
};
type HostSnapshot = Pick<HostConnection, "runtimeInstanceId" | "metadata" | "authorizedOwnerIds">;

export class PeerRegistry {
  private nextConnId = 0;
  private readonly endpoints = new Map<string, HostConnection>();
  private readonly owners = new Map<string, Map<number, OwnerConnection>>();
  private readonly pairingOffers = new Map<string, PairingOfferRecord>();
  private readonly discoveryBudget: DiscoveryBudget;

  constructor(
    private readonly now: () => number = Date.now,
    limits: { maxDiscoveryBytes: number; maxSubscriptions: number } = DEFAULT_RELAY_LIMITS,
  ) {
    this.discoveryBudget = new DiscoveryBudget(limits.maxDiscoveryBytes, limits.maxSubscriptions);
  }

  registerHost(hello: HostHello, outbound: Outbound): number {
    const key = endpointKey(hello.deviceId, hello.endpointId);
    const previous = this.endpoints.get(key);
    const discoveryBytes = this.discoveryBudget.measure(hello.deviceId, endpointInfo(hello.endpointId, hello));
    this.discoveryBudget.assertReplacement(previous?.discoveryBytes ?? 0n, discoveryBytes);
    const connId = this.nextId();
    this.removeOffersForEndpoint(hello.deviceId, hello.endpointId);
    const current: HostConnection = {
      connId,
      runtimeInstanceId: hello.runtimeInstanceId,
      metadata: hello.metadata,
      authorizedOwnerIds: hello.authorizedOwnerIds,
      outbound,
      discoveryBytes,
    };
    this.endpoints.set(key, current);
    this.discoveryBudget.commitReplacement(previous?.discoveryBytes ?? 0n, discoveryBytes);
    this.notifyVisibility(hello.deviceId, hello.endpointId, previous, current);
    return connId;
  }

  registerOwner(ownerId: string, outbound: Outbound): number {
    const connId = this.nextId();
    const connections = this.owners.get(ownerId) ?? new Map<number, OwnerConnection>();
    connections.set(connId, {
      outbound,
      subscribedDeviceIds: new Set(),
      pairingResolveWindowStartedAt: this.now(),
      pairingResolveCount: 0,
    });
    this.owners.set(ownerId, connections);
    return connId;
  }

  unregisterHost(deviceId: string, endpointId: string, connId: number): void {
    const key = endpointKey(deviceId, endpointId);
    const current = this.endpoints.get(key);
    if (current?.connId !== connId) return;
    this.endpoints.delete(key);
    this.discoveryBudget.release(current.discoveryBytes);
    this.removeOffersForEndpoint(deviceId, endpointId);
    this.notifyVisibility(deviceId, endpointId, current, undefined);
  }

  unregisterOwner(ownerId: string, connId: number): void {
    const connections = this.owners.get(ownerId);
    if (connections === undefined) return;
    connections.delete(connId);
    if (connections.size === 0) this.owners.delete(ownerId);
  }

  subscribeEndpoints(ownerId: string, connId: number, deviceIds: string[]): boolean {
    const owner = this.owners.get(ownerId)?.get(connId);
    if (owner === undefined) return false;
    owner.subscribedDeviceIds = new Set(deviceIds);
    for (const deviceId of owner.subscribedDeviceIds) {
      if (this.owners.get(ownerId)?.get(connId) !== owner) return false;
      const endpoints: RelayEndpointInfo[] = [];
      for (const [key, host] of this.endpoints) {
        const [registeredDeviceId, endpointId] = splitEndpointKey(key);
        if (registeredDeviceId === deviceId && host.authorizedOwnerIds.has(ownerId)) endpoints.push(endpointInfo(endpointId, host));
      }
      owner.outbound.send(stringifyWire({ type: "endpoints", device_id: deviceId, endpoints }));
    }
    return true;
  }

  updateHost(deviceId: string, endpointId: string, connId: number, update: EndpointUpdate): boolean {
    const current = this.endpoints.get(endpointKey(deviceId, endpointId));
    if (current?.connId !== connId) return false;
    const previous = snapshot(current);
    const next: HostSnapshot = {
      runtimeInstanceId: current.runtimeInstanceId,
      metadata: update.metadata ?? current.metadata,
      authorizedOwnerIds: update.authorizedOwnerIds ?? current.authorizedOwnerIds,
    };
    const discoveryBytes = this.discoveryBudget.measure(deviceId, endpointInfo(endpointId, next));
    this.discoveryBudget.assertReplacement(current.discoveryBytes, discoveryBytes);
    current.metadata = next.metadata;
    current.authorizedOwnerIds = next.authorizedOwnerIds;
    this.discoveryBudget.commitReplacement(current.discoveryBytes, discoveryBytes);
    current.discoveryBytes = discoveryBytes;
    this.notifyVisibility(deviceId, endpointId, previous, current);
    return true;
  }

  isActiveHost(deviceId: string, endpointId: string, connId: number): boolean {
    return this.endpoints.get(endpointKey(deviceId, endpointId))?.connId === connId;
  }

  publishPairingOffer(deviceId: string, endpointId: string, connId: number, offer: PairingOffer): boolean {
    const now = this.now();
    this.removeExpiredOffers(now);
    const host = this.endpoints.get(endpointKey(deviceId, endpointId));
    if (host?.connId !== connId || host.runtimeInstanceId !== offer.runtimeInstanceId) return false;
    if (offer.endpointId !== endpointId) return false;
    const collision = this.pairingOffers.get(offer.code);
    if (collision !== undefined && (collision.deviceId !== deviceId || collision.endpointId !== endpointId)) return false;
    this.removeOffersForEndpoint(deviceId, endpointId);
    // 到期取主机声明时间戳与 Relay 接收窗口（本机时钟 + TTL 上限）中较早者：
    // 超出上限的时间戳不再被拒绝，主机时钟偏差只会让配对提前失效，不会绕过上限。
    const windowExpiry = now + PAIR_TTL_MAX_MS;
    this.pairingOffers.set(offer.code, {
      deviceId,
      endpointId: offer.endpointId,
      runtimeInstanceId: offer.runtimeInstanceId,
      connId,
      expiresAt: compareExactInteger(offer.expiresAt, windowExpiry) <= 0 ? offer.expiresAt : windowExpiry,
    });
    return true;
  }

  resolvePairingCode(ownerId: string, connId: number, request: ResolvePairingCode): PairingResolveOutcome {
    const owner = this.owners.get(ownerId)?.get(connId);
    if (owner === undefined) return "stale_owner";
    const now = this.now();
    if (now - owner.pairingResolveWindowStartedAt >= PAIRING_RESOLVE_WINDOW_MS) {
      owner.pairingResolveWindowStartedAt = now;
      owner.pairingResolveCount = 0;
    }
    if (owner.pairingResolveCount >= PAIRING_RESOLVE_LIMIT) {
      owner.outbound.send(pairingError(request.requestId, "rate_limited"));
      return "rate_limited";
    }
    owner.pairingResolveCount += 1;
    this.removeExpiredOffersExcept(now, request.code);
    const offer = this.pairingOffers.get(request.code);
    if (offer === undefined) {
      owner.outbound.send(pairingError(request.requestId, "unknown_code"));
      return "unknown_code";
    }
    if (compareExactInteger(offer.expiresAt, now) <= 0) {
      this.pairingOffers.delete(request.code);
      owner.outbound.send(pairingError(request.requestId, "expired_code"));
      return "expired_code";
    }
    const host = this.endpoints.get(endpointKey(offer.deviceId, offer.endpointId));
    if (host?.connId !== offer.connId || host.runtimeInstanceId !== offer.runtimeInstanceId) {
      this.pairingOffers.delete(request.code);
      owner.outbound.send(pairingError(request.requestId, "stale_target"));
      return "stale_target";
    }
    // 对端 close 帧到达后 socket 即不再 OPEN，但注销要等 socket close 事件；期间视同已断开，避免解析出即将失效的目标。
    if (!host.outbound.isOpen()) {
      this.removeOffersForEndpoint(offer.deviceId, offer.endpointId);
      owner.outbound.send(pairingError(request.requestId, "unknown_code"));
      return "unknown_code";
    }
    owner.outbound.send(stringifyWire({
      type: "pairing_target",
      in_reply_to: request.requestId,
      code: request.code,
      device_id: offer.deviceId,
      endpoint_id: offer.endpointId,
      runtime_instance_id: offer.runtimeInstanceId,
    }));
    return "resolved";
  }

  routeFromOwner(ownerId: string, connId: number, route: RouteFrame): RouteOutcome {
    if (route.target_owner_id !== undefined || route.source_owner_id !== undefined) return "unauthorized";
    if (!this.owners.get(ownerId)?.has(connId)) return "stale";
    const host = this.endpoints.get(endpointKey(route.device_id, route.endpoint_id));
    if (host === undefined) return "unavailable";
    if (host.runtimeInstanceId !== route.runtime_instance_id) return "stale";
    if (route.purpose === "session" && !host.authorizedOwnerIds.has(ownerId)) return "unauthorized";
    return host.outbound.send(stringifyWire({ ...route, source_owner_id: ownerId })) ? "delivered" : "unavailable";
  }

  routeFromHost(deviceId: string, endpointId: string, connId: number, route: RouteFrame): RouteOutcome {
    if (route.target_owner_id === undefined) return "unauthorized";
    const host = this.endpoints.get(endpointKey(deviceId, endpointId));
    if (host === undefined) return "stale";
    if (
      host.connId !== connId || route.device_id !== deviceId || route.endpoint_id !== endpointId ||
      route.runtime_instance_id !== host.runtimeInstanceId || route.source_owner_id !== undefined
    ) return "stale";
    if (route.purpose === "session" && !host.authorizedOwnerIds.has(route.target_owner_id)) return "unauthorized";
    const owners = this.owners.get(route.target_owner_id);
    if (owners === undefined) return "unavailable";
    const line = stringifyWire(route);
    let delivered = false;
    for (const [ownerConnId, owner] of [...owners]) {
      if (this.owners.get(route.target_owner_id)?.get(ownerConnId) === owner) delivered = owner.outbound.send(line) || delivered;
    }
    return delivered ? "delivered" : "unavailable";
  }

  private notifyVisibility(deviceId: string, endpointId: string, previous?: HostSnapshot, current?: HostConnection): void {
    const previousInfo = previous === undefined ? undefined : endpointInfo(endpointId, previous);
    const currentInfo = current === undefined ? undefined : endpointInfo(endpointId, current);
    for (const [ownerId, connections] of [...this.owners]) {
      const wasAuthorized = previous?.authorizedOwnerIds.has(ownerId) ?? false;
      const isAuthorized = current?.authorizedOwnerIds.has(ownerId) ?? false;
      let line: string | undefined;
      if (!wasAuthorized && isAuthorized && currentInfo !== undefined) line = endpointEvent("endpoint_announced", deviceId, currentInfo, true);
      else if (wasAuthorized && isAuthorized && currentInfo !== undefined) line = endpointEvent("endpoint_updated", deviceId, currentInfo, true);
      else if (wasAuthorized && !isAuthorized && previousInfo !== undefined) line = endpointEvent("endpoint_ended", deviceId, previousInfo, false);
      if (line === undefined) continue;
      for (const [ownerConnId, owner] of [...connections]) {
        if (this.owners.get(ownerId)?.get(ownerConnId) === owner && owner.subscribedDeviceIds.has(deviceId)) {
          owner.outbound.send(line);
        }
      }
    }
  }

  private removeOffersForEndpoint(deviceId: string, endpointId: string): void {
    for (const [code, offer] of this.pairingOffers) {
      if (offer.deviceId === deviceId && offer.endpointId === endpointId) this.pairingOffers.delete(code);
    }
  }

  private removeExpiredOffers(now: number): void {
    for (const [code, offer] of this.pairingOffers) if (compareExactInteger(offer.expiresAt, now) <= 0) this.pairingOffers.delete(code);
  }

  private removeExpiredOffersExcept(now: number, requestedCode: string): void {
    for (const [code, offer] of this.pairingOffers) {
      if (code !== requestedCode && compareExactInteger(offer.expiresAt, now) <= 0) this.pairingOffers.delete(code);
    }
  }

  private nextId(): number {
    const id = this.nextConnId;
    this.nextConnId += 1;
    return id;
  }
}

function endpointKey(deviceId: string, endpointId: string): string {
  return `${deviceId}\u0000${endpointId}`;
}

function splitEndpointKey(key: string): [string, string] {
  const separator = key.indexOf("\u0000");
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function snapshot(host: HostConnection): HostSnapshot {
  return { runtimeInstanceId: host.runtimeInstanceId, metadata: host.metadata, authorizedOwnerIds: new Set(host.authorizedOwnerIds) };
}

function endpointInfo(endpointId: string, host: HostSnapshot): RelayEndpointInfo {
  return { endpoint_id: endpointId, runtime_instance_id: host.runtimeInstanceId, metadata: host.metadata };
}

function endpointEvent(type: string, deviceId: string, endpoint: RelayEndpointInfo, includeMetadata: boolean): string {
  return stringifyWire({
    type,
    device_id: deviceId,
    endpoint_id: endpoint.endpoint_id,
    runtime_instance_id: endpoint.runtime_instance_id,
    ...(includeMetadata ? { metadata: endpoint.metadata } : {}),
  });
}

function pairingError(inReplyTo: string, reason: Exclude<PairingResolveOutcome, "resolved" | "stale_owner">): string {
  return stringifyWire({ type: "pairing_code_error", in_reply_to: inReplyTo, reason });
}
