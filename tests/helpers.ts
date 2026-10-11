import type { Page } from "@playwright/test";

export async function mockDesktop(page: Page, failSend = true) {
  await page.addInitScript(({ failSend }) => {
    const projects = [
      { id: "alpha", name: "agent-deck", dir: "C:\\workspace\\agent-deck", created_at: 0 },
      { id: "beta", name: "website", dir: "C:\\workspace\\website", created_at: 0 },
    ];
    const row = (id: string, project: number, prompt: string, harness = "zcode") => ({
      id, prompt, harness, cwd: projects[project].dir, project_id: projects[project].id,
      mode: harness === "codex" ? "write" : "yolo", model: null, session_id: id,
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
    w.__testTasks = tasks;
    const deleted: string[][] = [];
    w.__testDeleted = deleted;
    w.__testProfileModels = profileModels;
    const requests: Record<string, unknown>[] = [];
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
        if (cmd === "check_harness") return { ready: true, issues: [] };
        if (cmd === "list_collaborations") return [];
        if (cmd === "list_projects") return projects.map((project) => ({ ...project }));
        if (cmd === "list_tasks") return tasks.map((task) => ({ ...task }));
        if (cmd === "delete_session") {
          if (w.__testDeleteError) throw new Error(String(w.__testDeleteError));
          const task = tasks.find((task) => task.id === args.taskId);
          if (!task) throw new Error("任务不存在");
          const ids = tasks.filter((item) => task.session_id
            ? item.harness === task.harness && item.session_id === task.session_id
            : item.id === task.id).map((item) => item.id);
          deleted.push(ids);
          for (let i = tasks.length - 1; i >= 0; i--) {
            if (ids.includes(tasks[i].id)) tasks.splice(i, 1);
          }
          return ids;
        }
        if (cmd === "get_default_cwd") return projects[0].dir;
        if (cmd === "get_task_diff") return "diff --git a/src/App.tsx b/src/App.tsx\n--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-const layout = \"previous\";\n+const layout = \"workspace\";\n";
        if (cmd === "discover_models") return ["gpt-test", "provider/a-very-long-model-name-for-layout-checks"];
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
          requests.push(args);
          const id = ++taskCount === 1 ? "new-task" : `new-task-${taskCount}`;
          const task = row(id, 0, String(args.prompt), String(args.harness));
          task.created_at = Date.now() + taskCount;
          task.status = "running";
          task.session_id = args.resumeSessionId ? String(args.resumeSessionId) : id;
          tasks.unshift(task);
          return { task_id: task.id };
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
