import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkflowPlan } from "./workflow-plan.mjs";
const harnesses = ["zcode", "codex", "opencode", "deck"];
const node = (id, harness, dependencies = []) => ({ id, harness, dependencies, prompt: id });
test("preserves a real four-executor dependency chain without model substitution", () => {
  const nodes = harnesses.map((h, i) => node(`stage-${i}`, h, i ? [`stage-${i - 1}`] : []));
  nodes[0].contract = { workspace: "artifacts", model_hint: "glm5.3flash", outputs: ["draft.md"], acceptance: false };
  const plan = normalizeWorkflowPlan({ nodes, parallel: 3 }, harnesses);
  assert.equal(plan.nodes.length, 4);
  assert.deepEqual(plan.nodes.map((n) => n.harness), harnesses);
  assert.equal(plan.nodes[0].contract.model_hint, "glm5.3flash");
  assert.equal(plan.nodes[0].execution.model, null);
});
test("rejects bad runners, dependencies and budgets instead of repairing the plan", () => {
  for (const nodes of [
    [node("a", "unknown")], [node("a", "codex", ["missing"])],
    [node("a", "codex", ["a"])], [node("a", "codex"), node("a", "deck")],
    [node("a", "codex", ["b"]), node("b", "deck", ["a"])],
  ]) assert.throws(() => normalizeWorkflowPlan({ nodes }, harnesses));
  assert.throws(() => normalizeWorkflowPlan({ nodes: [node("a", "deck")], parallel: 0 }, harnesses));
});
test("supports many independent command groups and preserves commander model selection", () => {
  const nodes = Array.from({ length: 20 }, (_, i) => ({
    ...node(`group-${i}`, "zcode"),
    supervision: { commander: "opencode", max_rounds: 2, model_hint: "desired-model",
      execution: { model: "provider/model", effort: "high" } },
  }));
  const plan = normalizeWorkflowPlan({ nodes, parallel: 4 }, harnesses);
  assert.equal(plan.nodes.length, 20);
  assert.equal(plan.nodes[19].supervision.execution.model, "provider/model");
});
