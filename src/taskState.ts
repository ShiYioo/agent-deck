import type { AgentEvent, LiveTask } from "./types";

export type LogItem = { event: AgentEvent; key: number };
export type TaskUpdate = {
  taskId: string;
  item?: LogItem;
  running?: boolean;
  status?: LiveTask["status"];
  exitCode?: number | null;
  todos?: LiveTask["todos"];
};

/** SDK updates contain snapshots, not deltas. Replace only the active stream. */
export function applyTaskUpdates(task: LiveTask, updates: TaskUpdate[]): LiveTask {
  const events = [...task.events];
  let next = { ...task, events };
  for (const update of updates) {
    if (update.item) {
      const event = update.item.event;
      const streaming = event.type === "assistant_message" || event.type === "thinking";
      const index = streaming && event.streamId
        ? events.findIndex(({ event: previous }) =>
            previous.type === event.type && previous.streaming && previous.streamId === event.streamId)
        : -1;
      if (index >= 0) events[index] = { ...update.item, key: events[index].key };
      else events.push(update.item);
      if (event.type === "session_id") next.sessionId = event.id;
    }
    if (update.running !== undefined) next.running = update.running;
    if (update.status !== undefined) next.status = update.status;
    if (update.exitCode !== undefined) next.exitCode = update.exitCode;
    if (update.todos !== undefined) next.todos = update.todos;
  }
  return next;
}
