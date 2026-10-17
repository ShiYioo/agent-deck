import type { AgentEvent, LiveTask } from "./types";

export type LogItem = { event: AgentEvent; key: number };
export type TaskUpdate = {
  taskId: string;
  item?: LogItem;
  running?: boolean;
  status?: LiveTask["status"];
  exitCode?: number | null;
  todos?: LiveTask["todos"];
  queuePaused?: boolean;
};

// Event arrays are immutable snapshots. Weak keys release the index with the
// snapshot; replacement-only batches can share their unchanged stream index.
const streamIndexes = new WeakMap<LogItem[], Map<string, number>>();
function streamKey(event: AgentEvent): string | undefined {
  return (event.type === "assistant_message" || event.type === "thinking") && event.streamId
    ? JSON.stringify([event.sourceTaskId ?? "", event.type, event.streamId]) : undefined;
}
function indexStreams(events: LogItem[]): Map<string, number> {
  const index = new Map<string, number>();
  events.forEach(({ event }, position) => {
    const key = streamKey(event);
    if (key && !index.has(key)) index.set(key, position);
  });
  streamIndexes.set(events, index);
  return index;
}

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
  let overlap = replayOverlap(history, received);
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

/** Longest replay suffix matching the buffered prefix, in linear time. Repeated
 * events must not make recovery repeatedly slice and rescan the whole buffer. */
function replayOverlap(history: string[], received: string[]): number {
  if (!received.length) return 0;
  const prefix = new Array<number>(received.length).fill(0);
  for (let i = 1, matched = 0; i < received.length; i++) {
    while (matched > 0 && received[i] !== received[matched]) matched = prefix[matched - 1];
    if (received[i] === received[matched]) matched++;
    prefix[i] = matched;
  }
  let matched = 0;
  for (const value of history) {
    while (matched > 0 && (matched === received.length || value !== received[matched])) matched = prefix[matched - 1];
    if (value === received[matched]) matched++;
  }
  return matched;
}

/** SDK updates contain snapshots, not deltas. Replace only the active stream. */
export function applyTaskUpdates(task: LiveTask, updates: TaskUpdate[]): LiveTask {
  let events = task.events;
  let streams = streamIndexes.get(events);
  let ownIndex = false;
  let next = task;
  for (const update of updates) {
    if (update.item) {
      if (task.workflowPlanning === (update.item.event.sourceTaskId ?? update.taskId) && !update.item.event.workflow_visible
        && !["user_message", "status", "error"].includes(update.item.event.type)) continue;
      const event = {
        ...update.item.event,
        sourceHarness: update.item.event.sourceHarness ?? (task.harness || undefined),
        sourceTaskId: update.item.event.sourceTaskId ?? update.taskId,
      };
      const item = { ...update.item, event };
      const key = streamKey(event);
      if (key && !streams) streams = indexStreams(events);
      const index = key ? streams?.get(key) : undefined;
      if (index !== undefined) {
        const previous = events[index].event;
        if ("streaming" in previous && previous.streaming === false && "streaming" in event && event.streaming === true) continue;
      }
      if (events === task.events) events = [...events];
      if (next === task) next = { ...task };
      next.events = events;
      if (index !== undefined) {
        events[index] = { ...item, key: events[index].key };
      } else {
        if (key) {
          if (!ownIndex) { streams = new Map(streams); ownIndex = true; }
          streams!.set(key, events.length);
        }
        events.push(item);
      }
      if (event.type === "session_id") next.sessionId = event.id;
      // 上下文压缩提示：状态行携带 compacting 标志
      if (event.type === "status" && typeof event.compacting === "boolean") next.compacting = event.compacting;
    }
    if (update.running !== undefined && update.running !== next.running) next = { ...next, running: update.running };
    if (update.status !== undefined && update.status !== next.status) next = { ...next, status: update.status };
    if (update.exitCode !== undefined && update.exitCode !== next.exitCode) next = { ...next, exitCode: update.exitCode };
    if (update.todos !== undefined && update.todos !== next.todos) next = { ...next, todos: update.todos };
    if (update.queuePaused !== undefined && update.queuePaused !== next.queuePaused) next = { ...next, queuePaused: update.queuePaused };
  }
  if (streams && events !== task.events) streamIndexes.set(events, streams);
  return next;
}
