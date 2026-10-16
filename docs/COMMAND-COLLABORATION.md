# Command Chains and Collaboration

AgentDeck's task graph supports independent workers and supervised command
chains in the same run. All four harnesses (`opencode`, `zcode`, `codex`, and
`deck`) can be either commander or worker; the two roles in a chain must differ.
Execution uses the existing native/CLI adapters and does not require MCP.

## Starting a Run

Open a completed conversation, then select execution details, context and
collaboration settings, and parallel collaboration. Use "添加指挥链" to add
as many chains as needed within the run's node limit. "指挥示例" loads an
editable example: OpenCode commanding Zcode alongside Codex commanding Deck;
this example does not limit the number of chains.
Fill in each task's requirements and select its permissions, models, reasoning
settings, and maximum execution rounds before starting.

Each node can instead run independently, use a different commander, or depend
on other nodes. A run supports 1-12 nodes, up to four concurrent stages, and a
1-60 minute total deadline. Supervised nodes allow 1-3 execution rounds.
The number of chains is independent of the concurrency limit: for example,
five chains with two slots run as dependencies and slots become available.
The preset starts read-only; enable writing explicitly when implementation is
required and the source conversation allows it.

## Execution Contract

1. The commander inspects the isolated worktree and supplies a plan and
   acceptance criteria.
2. The worker implements or analyzes the task in that worktree.
3. The commander inspects the actual files and verification evidence.
4. A final structured approval completes the chain. Otherwise the worker
   receives the stage history and reworks the existing files.
5. Exhausting the round budget produces `needs_attention`, never acceptance.

Each stage currently starts a fresh native task with the chain's explicit
history. It does not resume another harness's native session. Stage history,
current phase, round, task identifiers, and resolved model settings are
persisted with the graph. Restarted active runs are interrupted and require
recovery handling; they are not silently replayed.

Only accepted nodes produce immutable patches for downstream dependencies.
Dependent worktrees include ancestor patches and reports. The source repository
requires a clean Git baseline and remains unchanged until explicit integration.
Conflicting patches fail integration while retaining the isolated artifacts.

## Relationship View

The editor previews one lane per task, showing commander, worker, and dependency
identifiers. Results show the same lanes with live stage and round information;
the active harness is highlighted. Selecting a task or dependency opens its
details, including planning, implementation, and review reports and links to
the individual stage conversations.

Stopping a chain cancels only that node; dependent nodes become blocked.
Independent nodes continue. Stopping the graph cancels all its active stages.
Zcode stages wait for its global model configuration lock; this adapter cannot
run multiple Zcode instances concurrently.

## External Control

With AgentDeck running, any harness with shell access can use the same engine:

```sh
pnpm runnerctl tasks
pnpm runnerctl submit --source TASK_ID --nodes-file plan.json --parallel 2
pnpm runnerctl runs --source TASK_ID
pnpm runnerctl wait RUN_ID --source TASK_ID
pnpm runnerctl cancel RUN_ID --node api
```

The nodes file is a JSON array, or an object with a `nodes` array. For example:

```json
[
  {
    "id": "api", "harness": "zcode", "prompt": "Implement and test the API",
    "dependencies": [], "read_only": false,
    "supervision": { "commander": "opencode", "max_rounds": 3 }
  },
  {
    "id": "client", "harness": "deck", "prompt": "Implement and test the client",
    "dependencies": [], "read_only": false,
    "supervision": { "commander": "codex", "max_rounds": 3 }
  }
]
```

Use an existing completed task as the source; its workspace, sharing policy,
and permission restrictions apply to the new graph. From outside this repository,
invoke `node ABSOLUTE_PATH_TO/scripts/runnerctl.mjs` instead of the package script.

The app binds an ephemeral loopback port and writes `control.json` in its app
data directory. Each app start rotates the bearer token. The CLI discovers this
file automatically, or accepts `--control-file` / `AGENT_DECK_CONTROL_FILE`.
The server rejects browser-origin requests and does not enable CORS. Treat the
discovery file as a local credential; the API grants the same execution scope
as the desktop. Submissions are not automatically retried: if a request times
out, query the source's runs before submitting again.

## Boundaries

This implements app-managed command chains and dependency-based collaboration.
The Deck agent can propose this graph through `propose_collaboration`, including
supervised nodes, and the UI confirms the plan using the existing approval flow.
Confirmed proposals first validate the pending approval and requested models,
then stop the waiting planner and wait for its persisted terminal status.
A single unsupervised node hands over in the original working directory without
requiring Git; multiple nodes and supervised chains use isolated task graphs.
The plan card allows selecting concrete execution models before confirming.
No launch-success acknowledgement is sent to the planner before launch succeeds.
External runners can submit, query, wait for, and cancel these same graphs.
Dynamic task claiming, arbitrary peer messaging, mid-run graph edits, and
coordinator elections are not part of this implementation.
