/** Structural validation only. Never repair an executor, dependency or budget. */
export function normalizeWorkflowPlan(args, harnesses) {
  if (!Array.isArray(args?.nodes) || !args.nodes.length || args.nodes.length > 1024) {
    throw new Error("协作计划需要 1 到 1024 个节点，并受平台当前额度限制");
  }
  const ids = new Set();
  const nodes = args.nodes.map((node) => {
    if (!node || typeof node.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(node.id)
      || ids.has(node.id) || !harnesses.includes(node.harness)
      || typeof node.prompt !== "string" || !node.prompt.trim()) {
      throw new Error("节点标识、运行器或任务要求无效；不会自动替换运行器");
    }
    ids.add(node.id);
    const execution = node.execution ?? {};
    const supervision = node.supervision;
    if (supervision && (!harnesses.includes(supervision.commander)
      || supervision.commander === node.harness || !Number.isInteger(supervision.max_rounds)
      || supervision.max_rounds < 1 || supervision.max_rounds > 3)) {
      throw new Error("指挥配置无效");
    }
    const dependencies = node.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((id) => typeof id !== "string")
      || new Set(dependencies).size !== dependencies.length) throw new Error("节点依赖无效");
    if (node.read_only !== undefined && typeof node.read_only !== "boolean") throw new Error("只读权限必须是布尔值");
    return {
      ...node, dependencies, read_only: node.read_only ?? true,
      execution: { model: execution.model ?? null, effort: execution.effort ?? null },
      supervision: supervision ? {
        ...supervision, execution: supervision.execution ?? { model: null, effort: null },
      } : null,
    };
  });
  const visited = new Set();
  while (visited.size < nodes.length) {
    const node = nodes.find((node) => !visited.has(node.id)
      && node.dependencies.every((id) => visited.has(id)));
    if (!node) throw new Error("任务图存在循环、自依赖或未知依赖；不会删除依赖继续执行");
    visited.add(node.id);
  }
  const parallel = args.parallel ?? 2;
  const minutes = args.minutes ?? 15;
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 64
    || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error("协作预算无效；不会截断或替换预算");
  }
  return { why: args.why ?? "", nodes, parallel, minutes };
}
