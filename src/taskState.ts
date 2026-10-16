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

/** History and IPC overlap while a running task is restored. Keep each event once. */
export function restoreTask(
  task: LiveTask, replay: LogItem[], buffered: TaskUpdate[],
): LiveTask {
  const fingerprint = (event: AgentEvent) => {
    const { sourceHarness: _h, sourceTaskId: _t, ts: _ts, ...content } = event as AgentEvent & { ts?: number };
    return JSON.stringify(content);
  };
  const history = replay.map(({ event }) => fingerprint(event));
  const received = buffered.flatMap((update) => update.item ? [fingerprint(update.item.event)] : []);
  let overlap = Math.min(history.length, received.length);
  while (overlap > 0 && !received.slice(0, overlap).every((value, i) => value === history[history.length - overlap + i])) overlap--;
  const tail = buffered.map((update) => {
    if (update.item && overlap > 0) {
      overlap--;
      const { item: _item, ...state } = update;
      return state;
    }
    return update;
  });
  return applyTaskUpdates(task, [
    ...replay.map((item) => ({ taskId: item.event.sourceTaskId ?? "", item })),
    ...tail,
  ]);
}

/** SDK updates contain snapshots, not deltas. Replace only the active stream. */
export function applyTaskUpdates(task: LiveTask, updates: TaskUpdate[]): LiveTask {
  const events = [...task.events];
  let next = { ...task, events };
  for (const update of updates) {
    if (update.item) {
      const event = {
        ...update.item.event,
        sourceHarness: update.item.event.sourceHarness ?? (task.harness || undefined),
        sourceTaskId: update.item.event.sourceTaskId ?? update.taskId,
      };
      const item = { ...update.item, event };
      const streaming = event.type === "assistant_message" || event.type === "thinking";
      const index = streaming && event.streamId
        ? events.findIndex(({ event: previous }) =>
            previous.type === event.type && previous.streaming && previous.streamId === event.streamId
            && previous.sourceTaskId === event.sourceTaskId)
        : -1;
      if (index >= 0) events[index] = { ...item, key: events[index].key };
      else events.push(item);
      if (event.type === "session_id") next.sessionId = event.id;
      // 上下文压缩提示：状态行携带 compacting 标志
      if (event.type === "status" && typeof event.compacting === "boolean") next.compacting = event.compacting;
    }
    if (update.running !== undefined) next.running = update.running;
    if (update.status !== undefined) next.status = update.status;
    if (update.exitCode !== undefined) next.exitCode = update.exitCode;
    if (update.todos !== undefined) next.todos = update.todos;
  }
  return next;
}
