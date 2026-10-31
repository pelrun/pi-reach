import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RelayDisplayStatus } from "./relay_lifecycle.js";

type FooterUi = Pick<ExtensionContext["ui"], "setStatus" | "theme">;

const LEGACY_STATUS_KEYS = ["pi-reach:control", "pi-reach:owner-active", "pi-reach:session"] as const;
const STATUS_PRESENTATION = {
  connecting: { color: "dim", text: "connecting" },
  connected: { color: "dim", text: "connected" },
  reconnecting: { color: "warning", text: "reconnecting" },
  off: { color: "dim", text: "off" },
  failed: { color: "error", text: "failed" },
} satisfies Record<RelayDisplayStatus, { color: "warning" | "dim" | "error"; text: string }>;

export function clearLegacyRelayStatuses(ui: FooterUi): void {
  for (const key of LEGACY_STATUS_KEYS) ui.setStatus(key, undefined);
}

export function renderRelayFooter(ui: FooterUi, displayStatus: RelayDisplayStatus): void {
  const { color, text } = STATUS_PRESENTATION[displayStatus];
  const prefix = "Pi Reach - ";
  const status = color === "dim"
    ? ui.theme.fg("dim", prefix + text)
    : ui.theme.fg("dim", prefix) + ui.theme.fg(color, text);
  ui.setStatus("pi-reach:relay", status);
}
