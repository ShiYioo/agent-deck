import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, RefreshCw, RotateCcw, Save, Search } from "lucide-react";
import {
  confirmConversationRecovery, getConversationInfo, inspectConversationRecovery, resetConversationBinding, searchConversationContext, updateConversationState,
  type ContextPage, type ConversationInfo, type RecoveryCheck,
} from "../api";
import { Disclosure } from "./Disclosure";
import CollaborationBoard from "./CollaborationBoard";

export default function ConversationContext({ taskId, onRecovered, onRecoveryChange }: {
  taskId: string; onRecovered: () => void;
  onRecoveryChange?: (taskId: string, blocked: boolean, summary: string) => void;
}) {
  const [info, setInfo] = useState<ConversationInfo | null>(null);
  const [goal, setGoal] = useState("");
  const [notes, setNotes] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContextPage | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [recoveryCheck, setRecoveryCheck] = useState<RecoveryCheck | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const recoveredCallback = useRef(onRecovered);
  recoveredCallback.current = onRecovered;
  const epoch = useRef(0);
  const queryEpoch = useRef(0);
  const dirty = !!info && (goal !== info.state.goal || notes !== info.state.notes);

  useEffect(() => {
    const current = ++epoch.current;
    setInfo(null);
    setResults(null);
    setQuery("");
    ++queryEpoch.current;
    setConfirmed(false);
    setRecoveryCheck(null);
    setBusy("load");
    setError(null);
    getConversationInfo(taskId).then((value) => {
      if (current !== epoch.current) return;
      setInfo(value);
      setGoal(value.state.goal);
      setNotes(value.state.notes);
    }).catch((reason) => {
      if (current === epoch.current) setError(String(reason));
    }).finally(() => { if (current === epoch.current) setBusy(null); });
    return () => { ++epoch.current; };
  }, [taskId]);

  const recoveryIds = info?.recovery_task_ids.join("\n") ?? "";
  useEffect(() => {
    if (info) onRecoveryChange?.(taskId, !!recoveryIds, recoveryCheck?.summary ?? "正在核对旧执行者和工作区，已有成果会保留");
  }, [taskId, !!info, recoveryIds, recoveryCheck, onRecoveryChange]);
  useEffect(() => {
    if (!recoveryIds) { setInspecting(false); return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setInspecting(true);
    const inspect = async () => {
      try {
        const ids = recoveryIds.split("\n");
        const checks = await Promise.all(ids.map(inspectConversationRecovery));
        if (disposed) return;
        const blocked = checks.find((check) => !check.safe);
        setRecoveryCheck(blocked ?? checks[0]);
        setError(null);
        if (!blocked) {
          // Backend rechecks ownership before releasing the lock; never replay the interrupted task.
          for (const id of ids) {
            if (disposed) return;
            await confirmConversationRecovery(id, true);
          }
          const next = await getConversationInfo(taskId);
          if (disposed) return;
          setInfo(next);
          recoveredCallback.current();
          return;
        }
      } catch (reason) {
        if (disposed) return;
        setError(String(reason));
      } finally {
        if (!disposed) setInspecting(false);
      }
      if (!disposed) timer = setTimeout(() => setRecoveryTick((tick) => tick + 1), 5000);
    };
    void inspect();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [taskId, recoveryIds, recoveryTick]);

  const run = async (name: string, action: (current: number) => Promise<void>) => {
    if (busy) return;
    const current = epoch.current;
    setBusy(name);
    setError(null);
    try { await action(current); }
    catch (reason) { if (current === epoch.current) setError(String(reason)); }
    finally { if (current === epoch.current) setBusy(null); }
  };
  const search = (offset = 0) => run("search", async (current) => {
    const queryVersion = queryEpoch.current;
    const page = await searchConversationContext(taskId, query, offset);
    if (current !== epoch.current || queryVersion !== queryEpoch.current) return;
    setResults((previous) => offset && previous
      ? { ...page, items: [...previous.items, ...page.items] } : page);
  });
  const reload = () => run("load", async (current) => {
    const value = await getConversationInfo(taskId);
    if (current !== epoch.current) return;
    setInfo(value);
    setGoal(value.state.goal);
    setNotes(value.state.notes);
  });

  return <section className="conversation-context" aria-label="会话上下文">
    {error && <div className="context-error" role="alert">{error}</div>}
    {!info && <button className="context-command" disabled={!!busy} onClick={reload}>
      {busy ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}{busy ? "加载中" : "重试"}
    </button>}
    {info && <>
      {/* 自动核对失败时才显示手动确认，避免异常中断后永久卡死输入区。 */}
      {!!info.recovery_task_ids.length && <div className="context-recovery">
        {recoveryCheck && <div className="context-recovery-status" role="status">
          <strong>{recoveryCheck.safe ? "恢复检查通过" : "正在保护上次的任务成果"}</strong><span>{recoveryCheck.summary}</span>
          <small>工作区：{recoveryCheck.workspace_path}</small>
        </div>}
        {!recoveryCheck && <div className="context-recovery-status" role="status">正在核对遗留进程和工作区…</div>}
        <button className="context-command" disabled={inspecting || !!busy} onClick={() => setRecoveryTick((tick) => tick + 1)}>
          <RefreshCw size={14} />{inspecting ? "核对中" : "重新检查"}
        </button>
        {recoveryCheck?.can_confirm && !recoveryCheck.safe && <>
        <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          已确认旧执行者结束，保留现有改动继续</label>
        <button className="context-command" disabled={!confirmed || !!busy || inspecting} onClick={() => void run("recovery", async (current) => {
          for (const id of info.recovery_task_ids) await confirmConversationRecovery(id, confirmed);
          const value = await getConversationInfo(taskId);
          if (current !== epoch.current) return;
          setInfo(value);
          setConfirmed(false);
          onRecovered();
        })}><Check size={14} />确认恢复</button></>}
      </div>}
      {/* 配置类信息统一收进一个默认收起的折叠项；动作类（上面的恢复确认）不进来 */}
      <Disclosure title="上下文与协作设置" className="context-disclosure">
        <div className="orchestration-hint">跨模型共享的目标与约束、各模型上次的会话记录，以及并行与边界设置。</div>
        <CollaborationBoard taskId={taskId} onChanged={onRecovered} />
        <Disclosure title="共享目标与约束" className="context-disclosure">
        <div className="orchestration-hint">写给后续模型看的目标、约束与已定决策，按版本比较后更新。</div>
        <form className="context-state" onSubmit={(event) => {
          event.preventDefault();
          void run("save", async (current) => {
            const state = await updateConversationState(taskId, info.state.version, goal, notes);
            if (current === epoch.current) setInfo((previous) => previous ? { ...previous, state } : previous);
          });
        }}>
          <label>目标<textarea aria-label="共享目标" value={goal} onChange={(event) => setGoal(event.target.value)} rows={2} /></label>
          <label>约束与决策<textarea aria-label="共享约束与决策" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} /></label>
          <div className="context-actions">
            <span>v{info.state.version}</span>
            <button type="submit" className="icon-button" title="保存共享任务" aria-label="保存共享任务" disabled={!dirty || !!busy}><Save size={16} /></button>
            <button type="button" className="icon-button" title="刷新共享任务" aria-label="刷新共享任务" disabled={!!busy}
              onClick={() => { if (!dirty || window.confirm("放弃未保存的共享任务改动？")) reload(); }}><RefreshCw size={16} /></button>
          </div>
        </form>
      </Disclosure>
      <Disclosure title="模型会话记录" className="context-disclosure">
        <div className="orchestration-hint">每个模型上次的会话句柄。重建只清除句柄，聊天原文与原生缓存都保留。</div>
        <div className="context-bindings">
          {info.bindings.map((binding) => <div key={`${binding.harness}:${binding.cwd}`}>
            <span>{binding.harness}</span><code title={binding.session_id}>{binding.session_id}</code><span>{binding.status === "done" ? "已完成" : binding.status === "running" ? "运行中" : "未完成"}</span>
            <button className="icon-button" title={`重建 ${binding.harness} 上下文`} aria-label={`重建 ${binding.harness} 上下文`}
              disabled={!!busy || binding.status === "running"} onClick={() => {
                if (!window.confirm(`重建 ${binding.harness} 上下文？聊天原文将保留，下次运行不再使用旧句柄。`)) return;
                void run("reset", async (current) => {
                  await resetConversationBinding(taskId, binding.harness);
                  const value = await getConversationInfo(taskId);
                  if (current !== epoch.current) return;
                  setInfo(value);
                  onRecovered();
                });
              }}><RotateCcw size={14} /></button>
          </div>)}
        </div>
        {info.deliveries.slice(0, 5).map((delivery) => <div className="context-delivery" key={delivery.task_id}>
          <span>{delivery.strategy === "delta" ? "增量同步" : "原文同步"}</span>
          <span>{delivery.status === "done" ? "本轮已完成" : delivery.status === "pending" ? "本轮待完成" : "本轮未完成"}</span>
        </div>)}
        <form className="context-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
          <input aria-label="搜索会话原文" placeholder="搜索原文" maxLength={512} value={query} onChange={(event) => {
            setQuery(event.target.value);
            ++queryEpoch.current;
            setResults(null);
          }} />
          <button type="submit" className="icon-button" title="搜索会话原文" aria-label="执行原文搜索" disabled={!!busy}><Search size={16} /></button>
        </form>
        {results && <div className="context-results">
          {!results.items.length && <span className="context-empty">无匹配记录</span>}
          {results.items.map((item) => <details key={`${item.task_id}:${item.seq}`}>
            <summary>{item.harness} · {String(item.event.type ?? "event")} · {item.seq}</summary>
            <pre>{JSON.stringify(item.event, null, 2)}</pre>
          </details>)}
          {results.next_offset !== null && <button className="context-command" disabled={!!busy} onClick={() => void search(results.next_offset!)}>
            加载更多
          </button>}
        </div>}
        </Disclosure>
      </Disclosure>
    </>}
  </section>;
}
