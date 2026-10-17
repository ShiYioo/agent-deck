import type { ConversationPhase } from "./components/ConversationStatus";

export function conversationState(input: {
  restoring: boolean; running: boolean; collaborating: boolean; waiting: boolean;
  compacting: boolean; status?: string; recovery: boolean;
}) {
  const busy = input.running || input.collaborating;
  const phase: ConversationPhase = input.waiting && busy ? "waiting"
    : input.restoring ? "restoring"
    : input.recovery && !busy ? "recovery"
    : input.compacting && input.running ? "compacting"
    : input.running ? "running"
    : input.collaborating ? "collaborating"
    : input.status === "failed" ? "failed"
    : input.status === "cancelled" ? "cancelled" : "done";
  return { phase, canStop: busy, delivery: busy ? "queue" as const : "send" as const };
}
