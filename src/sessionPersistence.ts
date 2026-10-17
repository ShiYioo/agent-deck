import type { LiveTask } from "./types";

const prefix = "agentdeck:session:v1:";
function read(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(prefix + key) ?? "null"); }
  catch { return null; }
}
function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, JSON.stringify(value));
  } catch { /* Restricted storage keeps the current in-memory session usable. */ }
}

/** Synchronous writes protect edits even when the app closes before an effect runs. */
export class DraftStore extends Map<string, string> {
  override get(key: string) {
    const stored = read(`draft:${key}`);
    return super.get(key) ?? (typeof stored === "string" ? stored : undefined);
  }
  override set(key: string, text: string) {
    write(`draft:${key}`, text || null);
    return super.set(key, text);
  }
  override delete(key: string) {
    write(`draft:${key}`, null);
    return super.delete(key);
  }
}

export type SavedQueue = Pick<LiveTask, "queued" | "queuedConfigs" | "queuePaused">;
export function forgetSession(taskId: string) {
  write(`queue:${taskId}`, null);
  write(`draft:${taskId}`, null);
}
export function saveQueue(taskId: string, task: SavedQueue) {
  write(`queue:${taskId}`, task.queued?.length ? {
    queued: task.queued, queuedConfigs: task.queuedConfigs, queuePaused: true,
  } : null);
}
export function loadQueue(taskId: string): SavedQueue {
  const value = read(`queue:${taskId}`) as SavedQueue | null;
  if (!value || !Array.isArray(value.queued) || !value.queued.every((text) => typeof text === "string")) return {};
  const configs = value.queuedConfigs;
  if (configs && (!Array.isArray(configs) || !configs.every((config) => config && typeof config === "object"
    && typeof config.model === "string" && typeof config.effort === "string"
    && (!config.harness || ["deck", "zcode", "codex", "opencode"].includes(config.harness))
    && (!config.attachments || (Array.isArray(config.attachments) && config.attachments.every((path) => typeof path === "string")))))) return {};
  return { queued: value.queued, queuedConfigs: configs, queuePaused: true };
}
