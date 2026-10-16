import { expect, type Page } from "@playwright/test";

/**
 * 展开一个折叠项；已经展开时不再点击。
 * 「接力与多模型配合」在任务失败或额度耗尽时默认展开，无条件 click 会把它收起来。
 * 判据用父级 <details> 的 open 属性：Disclosure 组件与 CollaborationBoard 里
 * 手写的原生 <details> 都设置它，而原生 <summary> 没有 aria-expanded。
 */
export async function openSection(page: Page, title: string) {
  const summary = page.locator("summary").filter({ hasText: new RegExp(`^${title}$`) });
  const details = summary.locator("xpath=..");
  if ((await details.getAttribute("open")) === null) await summary.click();
  await expect(details).toHaveAttribute("open", "");
}

export async function mockDesktop(page: Page, failSend = true) {
  await page.addInitScript(({ failSend }) => {
    const projects = [
      { id: "alpha", name: "agent-deck", dir: "C:\\workspace\\agent-deck", created_at: 0 },
      { id: "beta", name: "website", dir: "C:\\workspace\\website", created_at: 0 },
    ];
    const row = (id: string, project: number, prompt: string, harness = "zcode") => ({
      id, prompt, harness, cwd: projects[project].dir, project_id: projects[project].id,
      mode: harness === "codex" ? "write" : "yolo", model: null, session_id: id,
      conversation_id: null as string | null,
      execution_config: null as { requested: { model: string | null; effort: string | null }; resolved: { model: string | null; effort: string | null }; transport: string } | null,
      base_branch: null, worktree_dir: null, status: "done", exit_code: 0, created_at: 0,
    });
    const tasks = [row("a", 0, "调整工作台布局"), row("b", 1, "检查响应式页面", "codex"), row("c", 0, "补充界面测试")];
    const profiles: Record<string, unknown>[] = [];
    const profileModels: Record<string, Record<string, unknown>[]> = {};
    let callbackId = 0;
    let taskCount = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const w = window as unknown as Record<string, unknown>;
    const calls: string[] = [];
    w.__testCalls = calls;
    w.__testInvokes = [];
    w.__testTasks = tasks;
    const deleted: string[][] = [];
    w.__testDeleted = deleted;
    w.__testProfileModels = profileModels;
    const requests: Record<string, unknown>[] = [];
    const executionDefaults: Record<string, { model: string | null; effort: string | null }> = {};
    const executionOverrides: Record<string, { target: string; version: number; config: unknown }[]> = {};
    w.__testRequests = requests;
    w.__emit = (event: string, payload: unknown) => {
      const value = payload as { taskId?: string; type?: string; path?: string; code?: number; event?: { type: string; id: string } };
      const task = tasks.find((task) => task.id === value.taskId);
      if (task) {
        if (value.event?.type === "session_id") task.session_id = value.event.id;
        if (value.type === "deck_session_file") task.session_id = String(value.path);
        if (event === "task-exit") {
          task.status = value.code === 0 ? "done" : value.code == null ? "cancelled" : "failed";
        }
      }
      for (const [id, listener] of listeners) {
        if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
      }
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, id: number) => listeners.delete(id),
    };
    w.__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => {
        callbacks.set(++callbackId, callback);
        return callbackId;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push(cmd);
        (w.__testInvokes as { cmd: string; args: Record<string, unknown> }[]).push({ cmd, args });
        if (cmd === "check_harness") return { ready: true, issues: [] };
        if (cmd === "get_execution_defaults") return executionDefaults[`${args.taskId ?? "default"}:${args.harness}`] ?? { model: null, effort: null };
        if (cmd === "set_execution_defaults") {
          executionDefaults[`${args.taskId ?? "default"}:${args.harness}`] = args.config as { model: string | null; effort: string | null };
          return;
        }
        if (cmd === "discover_models") return args.harness === "codex" ? [
          "gpt-test", "gpt-no-effort",
        ] : args.harness === "opencode" ? [
          "opencode/test-free", "opencode/plain-free",
        ] : args.harness === "zcode" ? [
          "zhipuai-coding-plan/GLM-5.3-Flash	智谱 Coding Plan	GLM-5.3-Flash",
          "zhipuai-coding-plan/GLM-5	智谱 Coding Plan	GLM-5",
        ] : [];
        if (cmd === "discover_execution_models") return args.harness === "codex" ? [
          { model: "gpt-test", efforts: ["low", "medium", "high"], context_window: 128000 },
          { model: "gpt-no-effort", efforts: [], context_window: 32000 },
           { model: "provider/a-very-long-model-name-for-layout-checks", efforts: [], context_window: 32000 },
        ] : args.harness === "opencode" ? [
          { model: "opencode/test-free", efforts: ["low", "high"], context_window: 64000 },
          { model: "opencode/plain-free", efforts: [], context_window: 32000 },
        ] : args.harness === "zcode" ? [
          { model: "zhipuai-coding-plan/GLM-5.3-Flash", efforts: [], context_window: 128000 },
          { model: "zhipuai-coding-plan/GLM-5", efforts: [], context_window: 128000 },
        ] : [];
        if (cmd === "list_execution_overrides") return structuredClone(executionOverrides[String(args.runId)] ?? []);
        if (cmd === "update_delegation_execution") {
          if (w.__testExecutionConflict) throw new Error("执行配置已被其他操作修改，请刷新后重试");
          const rows = executionOverrides[String(args.runId)] ??= [];
          const previous = rows.find((r) => r.target === args.target);
          if ((previous?.version ?? 0) !== args.expectedVersion) throw new Error("执行配置版本冲突");
          const next = { target: String(args.target), version: Number(args.expectedVersion) + 1, config: args.config };
          if (previous) Object.assign(previous, next); else rows.push(next);
          w.__testExecutionRequest = args;
          return structuredClone(next);
        }
        if (cmd === "get_setting" && String(args.key).startsWith("transport_")) {
          return ((w.__testTransports ?? {}) as Record<string, string>)[String(args.key)] ?? "cli";
        }
        if (cmd === "set_setting" && String(args.key).startsWith("transport_")) {
          const transports = (w.__testTransports ??= {}) as Record<string, string>;
          transports[String(args.key)] = String(args.value);
          return;
        }
        if (cmd === "get_context_policy") return w.__testContextPolicy ?? {
          version: 0, allowed_harnesses: ["codex", "opencode", "zcode", "deck"], redact_secrets: true,
          blocked_terms: [], context_window: 32768, output_reserve: 8192, overhead_reserve: 8192,
        };
        if (cmd === "update_context_policy") {
          if (w.__testPolicyConflict) throw new Error("共享策略已更新，请刷新后重试");
          w.__testPolicyRequest = args;
          return w.__testContextPolicy = { ...(args.policy as Record<string, unknown>), version: Number(args.expectedVersion) + 1 };
        }
        if (cmd === "list_graph_runs") return structuredClone(w.__testGraphs ?? []);
        if (cmd === "start_approved_plan") {
          w.__testApprovedPlanRequest = args;
          if (w.__testApprovedPlanError) throw new Error(String(w.__testApprovedPlanError));
          const source = tasks.find((task) => task.id === args.taskId)!;
          const emit = w.__emit as (event: string, payload: unknown) => void;
          emit("task-exit", { taskId: source.id, code: null, status: "cancelled" });
          const nodes = args.nodes as Record<string, unknown>[];
          if (nodes.length === 1 && !nodes[0].supervision) {
            const node = nodes[0];
            const worker = { ...row("planned-worker", 0, String(node.prompt), String(node.harness)),
              status: "running", cwd: source.cwd, conversation_id: source.conversation_id ?? source.id,
              model: (node.execution as { model?: string })?.model ?? null };
            tasks.unshift(worker);
            if (w.__testApprovedPlanEarlyEvent) {
              emit("task-event", { taskId: worker.id, event: w.__testApprovedPlanEarlyEvent });
            }
            return { kind: "task", task_id: worker.id, run: null };
          }
          args.sourceTaskId = source.id;
          args.maxParallel = 2;
          args.timeoutSecs = 900;
        }
        if (cmd === "start_graph_run" || cmd === "start_approved_plan") {
          if (w.__testGraphError) throw new Error(String(w.__testGraphError));
          w.__testGraphRequest = args;
          const run = {
            id: "graph-test", source_task_id: String(args.sourceTaskId), conversation_id: String(args.sourceTaskId),
            cwd: projects[0].dir, base_commit: "0123456789abcdef", status: "running", integrated: false,
            max_parallel: args.maxParallel, timeout_secs: args.timeoutSecs, error: null,
            nodes: (args.nodes as Record<string, unknown>[]).map((spec) => ({
              spec, status: "pending", task_id: null, report: null, error: null, patch_path: null, patch_hash: null, worktree: null,
            })),
          };
          w.__testGraphs = [run];
          return cmd === "start_approved_plan"
            ? { kind: "graph", task_id: null, run: structuredClone(run) } : structuredClone(run);
        }
        if (cmd === "cancel_graph_run") {
          const runs = w.__testGraphs as Record<string, unknown>[];
          const run = runs.find((r) => r.id === args.id)!;
          run.status = "cancelled";
          return;
        }
        if (cmd === "cancel_graph_node") {
          const run = (w.__testGraphs as Record<string, unknown>[]).find((r) => r.id === args.id)!;
          const node = (run.nodes as Record<string, unknown>[]).find((n) =>
            (n.spec as Record<string, unknown>).id === args.nodeId)!;
          node.status = "cancelled";
          w.__testCancelNodeRequest = args;
          return;
        }
        if (cmd === "integrate_graph_run") {
          if (!args.confirmed) throw new Error("集成成果需要明确确认");
          if (w.__testIntegrationError) throw new Error(String(w.__testIntegrationError));
          const runs = w.__testGraphs as Record<string, unknown>[];
          const run = runs.find((r) => r.id === args.id)!;
          run.integrated = true;
          w.__testIntegrationRequest = args;
          return structuredClone(run);
        }
        if (cmd === "discard_graph_run") {
          if (!args.confirmed) throw new Error("移除隔离成果需要明确确认");
          const runs = w.__testGraphs as Record<string, unknown>[];
          const run = runs.find((r) => r.id === args.id)!;
          run.status = "discarded";
          w.__testDiscardRequest = args;
          return structuredClone(run);
        }
        if (cmd === "list_collaborations") return w.__testCollaborations ?? [];
        if (cmd === "start_collaboration") {
          const source = tasks.find((task) => task.id === args.sourceTaskId)!;
          const run = {
            id: "flow", source_task_id: source.id, conversation_id: source.conversation_id ?? source.id,
            mentor: args.mentor, worker: args.worker, status: "running", phase: "planning",
            round: 0, max_rounds: args.maxRounds, current_task_id: null, task_ids: [], error: null,
            read_only: args.readOnly, phase_timeout_secs: args.phaseTimeoutSecs,
            execution: args.execution,
          };
          w.__testCollaborationRequest = args;
          w.__testCollaborations = [run];
          (w.__emit as (name: string, payload: unknown) => void)("collaboration-update", run);
          return run;
        }
        if (cmd === "cancel_collaboration") {
          const runs = w.__testCollaborations as Record<string, unknown>[];
          const run = runs.find((item) => item.id === args.id)!;
          run.status = "cancelled";
          (w.__emit as (name: string, payload: unknown) => void)("collaboration-update", run);
          return;
        }
        if (cmd === "list_projects") return projects.map((project) => ({ ...project }));
        if (cmd === "list_tasks") return tasks.map((task) => ({ ...task }));
        if (cmd === "delete_session") {
          if (w.__testDeleteError) throw new Error(String(w.__testDeleteError));
          const task = tasks.find((task) => task.id === args.taskId);
          if (!task) throw new Error("任务不存在");
          const ids = tasks.filter((item) => task.conversation_id
            ? item.conversation_id === task.conversation_id
            : task.session_id ? item.harness === task.harness && item.session_id === task.session_id
            : item.id === task.id).map((item) => item.id);
          deleted.push(ids);
          for (let i = tasks.length - 1; i >= 0; i--) {
            if (ids.includes(tasks[i].id)) tasks.splice(i, 1);
          }
          return ids;
        }
        if (cmd === "get_default_cwd") return projects[0].dir;
        if (cmd === "get_conversation_info") {
          const source = tasks.find((task) => task.id === args.taskId)!;
          const cid = source.conversation_id ?? source.id;
          const states = (w.__testSharedStates ??= {}) as Record<string, { version: number; goal: string; notes: string }>;
          return {
            conversation_id: cid, state: states[cid] ?? { version: 0, goal: "", notes: "" },
            bindings: tasks.filter((task) => !!task.session_id && (task.id === source.id || task.conversation_id === cid))
              .map((task) => ({ harness: task.harness, cwd: task.cwd, session_id: task.session_id,
                task_id: task.id, cursor_task_id: task.status === "done" ? task.id : null, status: task.status })),
            recovery_task_ids: w.__testRecoveryTasks ?? [], deliveries: [],
          };
        }
        if (cmd === "update_conversation_state") {
          if (w.__testStateConflict) throw new Error("共享任务状态已更新，请刷新后再保存");
          const source = tasks.find((task) => task.id === args.taskId)!;
          const cid = source.conversation_id ?? source.id;
          const states = (w.__testSharedStates ??= {}) as Record<string, { version: number; goal: string; notes: string }>;
          const previous = states[cid] ?? { version: 0, goal: "", notes: "" };
          if (previous.version !== args.expectedVersion) throw new Error("共享任务状态已更新，请刷新后再保存");
          return states[cid] = { version: previous.version + 1, goal: String(args.goal), notes: String(args.notes) };
        }
        if (cmd === "reset_conversation_binding") {
          const source = tasks.find((task) => task.id === args.taskId)!;
          const cid = source.conversation_id ?? source.id;
          for (const task of tasks) {
            if ((task.id === source.id || task.conversation_id === cid) && task.harness === args.harness) {
              task.session_id = null as unknown as string;
            }
          }
          return;
        }
        if (cmd === "confirm_conversation_recovery") {
          if (!args.confirmed) throw new Error("请先确认旧执行者已结束");
          w.__testRecoveryTasks = (w.__testRecoveryTasks as string[]).filter((id) => id !== args.taskId);
          w.__testRecoveryConfirmed = args;
          return;
        }
        if (cmd === "inspect_conversation_recovery") {
          const blocked = !!w.__testRecoveryBlocked;
          return { safe: !blocked, active_processes: blocked ? ["zcode"] : [], workspace_changed: false,
            workspace_path: projects[0].dir, summary: blocked ? "仍有受管执行进程运行：zcode" : "已确认旧执行进程结束，工作区没有未提交改动" };
        }
        if (cmd === "search_conversation_context") {
          const rows = (w.__testContextRows ?? []) as { task_id: string; harness: string; seq: number; event: Record<string, unknown> }[];
          const matched = rows.filter((row) => JSON.stringify(row.event).includes(String(args.query)));
          const offset = Number(args.offset);
          return { items: matched.slice(offset, offset + 20),
            next_offset: offset + 20 < matched.length ? offset + 20 : null };
        }
        if (cmd === "get_task_diff") return "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-const layout = \"previous\";\n+const layout = \"workspace\";\n";
        if (cmd === "discover_models") return ["gpt-test", "provider/a-very-long-model-name-for-layout-checks"];
        if (cmd === "get_task_events" && (w.__testTaskEvents as Record<string, unknown[]> | undefined)?.[String(args.taskId)]) {
          const snapshot = structuredClone((w.__testTaskEvents as Record<string, unknown[]>)[String(args.taskId)]);
          (w.__testBeforeTaskReplay as (() => void) | undefined)?.();
          return snapshot;
        }
        if (cmd === "get_task_events") return [
          { type: "user_message", text: "请调整工作台布局，并验证小屏幕下的表现。" },
          { type: "thinking", text: "检查布局和输入区。" },
          { type: "tool_use", tool: "read", detail: "src/App.tsx" },
          { type: "tool_result", tool: "read", ok: true, detail: "文件内容\n".repeat(20) },
          { type: "assistant_message", text: "## 已完成\n\n调整了 **侧栏** 和输入区。\n\n- 项目分组\n- 响应式布局\n\n```tsx\nconst ready = true;\n```\n\n| 检查 | 结果 |\n| --- | --- |\n| 布局 | 通过 |" },
          { type: "complete", ok: true },
        ];
        if (cmd === "start_task") {
          if (failSend) throw new Error("模拟启动失败");
          if (!Object.prototype.hasOwnProperty.call(args, "attachments")) {
            throw new Error("invalid args `attachments` for command `start_task`");
          }
          let conversationId: string | null = null;
          if (args.conversationId) {
            const source = tasks.find((task) => task.id === args.conversationId);
            if (!source) throw new Error("会话不存在");
            const legacy = source.session_id ? tasks.filter((task) =>
              !task.conversation_id && task.harness === source.harness && task.session_id === source.session_id)
              .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)) : [source];
            conversationId = source.conversation_id ?? legacy[0].id;
            for (const task of legacy) task.conversation_id ??= conversationId;
            if (tasks.some((task) => task.conversation_id === conversationId && task.status === "running")) {
              throw new Error("当前会话已有执行者运行中，请等待结束或停止后再接力");
            }
            if (((w.__testCollaborations ?? []) as Record<string, unknown>[]).some((run) =>
              run.conversation_id === conversationId && run.status === "running")) {
              throw new Error("该工作目录已有执行或协作占用，请等待结束");
            }
          }
          requests.push(args);
          const id = ++taskCount === 1 ? "new-task" : `new-task-${taskCount}`;
          const task = row(id, 0, String(args.prompt), String(args.harness));
          task.created_at = Date.now() + taskCount;
          task.status = "running";
          task.mode = String(args.mode ?? "default");
          const config = { model: args.model == null ? null : String(args.model), effort: args.effort == null ? null : String(args.effort) };
          task.execution_config = { requested: config, resolved: config, transport: "cli" };
          const binding = conversationId ? tasks.find((task) =>
            task.conversation_id === conversationId && task.harness === args.harness && task.session_id) : undefined;
          task.session_id = args.resumeSessionId ? String(args.resumeSessionId) : binding?.session_id ?? id;
          task.conversation_id = conversationId ?? id;
          task.cwd = String(args.cwd);
          task.project_id = args.projectId ? String(args.projectId) : task.project_id;
          tasks.unshift(task);
          return { task_id: task.id };
        }
        if (cmd === "cancel_task") {
          if (w.__testCancelError) throw new Error(String(w.__testCancelError));
          if (w.__testCancelDeferred) return;
          const task = tasks.find((task) => task.id === args.taskId);
          if (task) task.status = "cancelled";
          (w.__emit as (event: string, payload: unknown) => void)("task-exit", { taskId: args.taskId, code: null });
          return;
        }
        if (cmd === "plugin:event|listen") {
          const id = ++callbackId;
          listeners.set(id, { event: String(args.event), handler: Number(args.handler) });
          return id;
        }
        if (cmd === "plugin:event|unlisten") listeners.delete(Number(args.eventId));
        if (cmd === "list_model_profiles") return profiles.map((p) => ({ ...p }));
        if (cmd === "add_model_profile") {
          // 真实 Tauri 2 只收 camelCase 键：snake_case 直接抛错，防回归
          if (!("apiKey" in args) || !("baseUrl" in args)) {
            throw new Error("add_model_profile 需要 camelCase 参数（apiKey/baseUrl）");
          }
          const profile = {
            id: `mp-${profiles.length + 1}`,
            provider: String(args.provider),
            label: (args.label as string | null) ?? null,
            api_key: String(args.apiKey),
            base_url: (args.baseUrl as string | null) ?? null,
            model: (args.model as string | null) ?? null,
            protocol: (args.protocol as string | null) ?? null,
            enabled: true,
            created_at: 0,
          };
          profiles.push(profile);
          return { ...profile };
        }
        if (cmd === "update_model_profile") {
          if (!("apiKey" in args) || !("baseUrl" in args)) {
            throw new Error("update_model_profile 需要 camelCase 参数（apiKey/baseUrl）");
          }
          const target = profiles.find((p) => p.id === args.id);
          if (!target) throw new Error("档案不存在");
          Object.assign(target, {
            provider: String(args.provider),
            label: (args.label as string | null) ?? null,
            api_key: String(args.apiKey),
            base_url: (args.baseUrl as string | null) ?? null,
            model: (args.model as string | null) ?? null,
            protocol: (args.protocol as string | null) ?? null,
          });
          return { ...target };
        }
        if (cmd === "list_profile_models") {
          return (profileModels[String(args.profileId)] ?? []).map((m) => ({ ...m }));
        }
        if (cmd === "add_profile_model") {
          const pid = String(args.profileId);
          (profileModels[pid] ??= []).push({
            id: `pm-${pid}-${(profileModels[pid]?.length ?? 0) + 1}`,
            profile_id: pid,
            model: String(args.model),
            context_window: (args.contextWindow as number | null) ?? null,
            max_tokens: (args.maxTokens as number | null) ?? null,
            rate_multiplier: null,
            created_at: 0,
          });
          return { ...(profileModels[pid] as unknown[]).at(-1) };
        }
        if (cmd === "update_profile_model") {
          if (!("contextWindow" in args) || !("maxTokens" in args)) {
            throw new Error("update_profile_model 需要 camelCase 参数（contextWindow/maxTokens）");
          }
          for (const list of Object.values(profileModels)) {
            const row = list.find((m) => m.id === args.id);
            if (row) {
              row.model = String(args.model);
              row.context_window = (args.contextWindow as number | null) ?? null;
              row.max_tokens = (args.maxTokens as number | null) ?? null;
              return null;
            }
          }
          throw new Error("模型行不存在");
        }
        if (cmd === "delete_profile_model") {
          for (const list of Object.values(profileModels)) {
            const i = list.findIndex((m) => m.id === args.id);
            if (i >= 0) list.splice(i, 1);
          }
          return null;
        }
        if (cmd === "clear_profile_models") {
          delete profileModels[String(args.profileId)];
          return null;
        }
        if (cmd === "fetch_upstream_models") return [];
        if (cmd === "fetch_upstream_rates") return { source: "sub2api", applied: 0 };
        if (cmd === "set_model_profile_enabled") {
          const target = profiles.find((p) => p.id === args.id);
          if (target) target.enabled = Boolean(args.enabled);
          return null;
        }
        if (cmd === "delete_model_profile") {
          const i = profiles.findIndex((p) => p.id === args.id);
          if (i >= 0) profiles.splice(i, 1);
          return null;
        }
        return null;
      },
    };
  }, { failSend });
}
