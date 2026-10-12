# Multi-Harness Implementation Record

Updated: 2026-10-12 (Asia/Shanghai).

This records shipped local behavior, not completion of every research proposal.

## Supported Local Contract

- One public conversation and separate native bindings for each harness/workspace.
- Sequential continuation does not invoke an independent summarization model.
- Public projections preserve origins and omit private thinking and hidden handoff requests.
- Versioned sharing policy controls recipient harnesses, blocked literal terms and credential filtering.
- Configurable window/output/overhead reserves select whole recent records. Overflow stays in a filtered retrieval archive.
- The estimate is a conservative UTF-8 byte bound, not a provider tokenizer or a verified model window.
- Current user input remains unchanged. Oversized requests are rejected explicitly instead of silently shortened.
- User goals/constraints remain versioned with compare-and-swap writes.

## Service Capability Matrix

| Harness | Entry | Verification | Boundaries |
| --- | --- | --- | --- |
| Codex 0.151.0 | CLI | Existing parser/runtime tests | Independent native binding |
| Codex 0.151.0 | App Server stdio | Real read-only turn, same-thread resume and both history tools | Experimental dynamic tools; no `thread/inject_items` import |
| OpenCode 1.18.30 | CLI | Parser/runtime tests; real `opencode/mimo-v2.6-flash-free` text generation and same-session continuation on 2026-10-12, both reporting cost 0 | Narrow no-tool smoke check, not mixed-harness coding acceptance |
| OpenCode 1.18.30 | Local Server REST/SSE | OpenAPI probe; real requests exercise error paths | Default provider returns HTTP 401 / Invalid token; explicit `opencode/mimo-v2.6-flash-free` returns HTTP 403 / FreeTierError in this entry |
| OpenCode 1.18.30 | ACP stdio | Protocol v1 initialize, real session load and confirmed plan-mode switch | Successful generation not yet verified |
| ZCode | CLI | Existing parser/runtime tests | No verified native service/ACP adapter |
| AgentDeck | Sidecar | Mock-provider runtime tests | Existing model pool and native session files |

The installed Codex JSON schemas were generated with `--experimental` before implementing its dynamic tool contract. App Server initialization and required thread/turn methods use those installed shapes, not guessed web-only APIs.

Native entries are opt-in. Switching entry asks for confirmation and resets the current conversation's native binding while preserving public history. A native execution error is terminal: it is never silently rerun through CLI. Users can explicitly select CLI as the compatibility fallback.

Each native task currently owns its service process tree. Services are not yet pooled across turns. This trades startup cost for deterministic task cleanup.

## Bounded History Tools

Codex App Server exposes:

- `agentdeck_search_history`: literal search over the current filtered snapshot, ten bounded hits per page.
- `agentdeck_read_history`: source record chunks up to 2048 UTF-8 bytes with Unicode-safe continuation offsets.

Tools are conversation-snapshot scoped, read-only, and reject invalid indexes/offsets. Native tool results are persisted as tool evidence, not disguised as shell execution or a new user message.

They are not a live SQLite/MCP service. Other entries currently use their existing filesystem tools to access the filtered archive. No semantic or FTS index is claimed.

## Isolated Task DAG

Entry: execution details -> parallel collaboration.

- 1-12 nodes; 1-3 concurrent tasks; one overall deadline of 60-3600 seconds.
- Explicit node harness, request, read-only setting and dependencies.
- Cycles, unknown dependencies, duplicate IDs and invalid budgets are rejected before dispatch.
- A clean Git repository root and existing HEAD are required. No automatic stash, commit or removal of user changes.
- The source directory is leased throughout the run. Each node has a detached worktree based on the recorded commit.
- Transitive dependency patches are verified and applied once in topological order.
- Node patches are deltas from the inherited tree, not repeated copies of ancestor changes.
- Staged/untracked non-ignored files and binary diffs are included.
- Read-only node changes are rejected. This detects a violated restriction in the isolated checkout; it is not an OS sandbox for every harness.
- Failure blocks dependent nodes, while already independent tasks may continue.
- Reports, native task IDs, worktree paths, baseline trees and Git blob hashes are persisted.
- Missing assistant reports are not treated as accepted work.
- Shared goal/constraint version changes stop the graph. New source changes prevent integration.
- Sharing-policy version changes also stop further graph execution.
- Dispatch and chat deletion share an owned conversation reservation from child startup through conversation attachment and graph persistence. Deletion during this interval refuses with a retryable error.
- Cancellation, the overall deadline, shared-state version and sharing-policy version are rechecked before and after worktree preparation and immediately before child startup. A stopped graph retains prepared isolated artifacts but does not dispatch the next child.
- Cancellation stops all active children and waits for terminal task state. Unclosed processes retain task/workspace recovery blocks.
- Restart marks graphs as needing attention and blocks source recovery; it does not rerun ambiguous writes.

## Explicit Integration And Removal

Integration requires confirmation and every node to finish successfully.

Patches are replayed into a temporary integration worktree in dependency order. Hashes and `git diff --check HEAD` are checked before applying the assembled patch to the source. The source HEAD and clean state are checked again just before application. Conflicts leave the source unchanged and keep isolated artifacts.

This is patch/content validation, not a replacement for project tests or human acceptance. Automated project-specific verification commands and a quality/cost benchmark suite are still missing.

Explicit removal is available for stopped/completed runs. Every resolved target must be beneath the application's managed worktree/artifact directories before any removal begins. Active/recovery-blocked directories refuse removal. Chat history and already integrated source edits are retained.

Deleting chat metadata does not automatically destroy unmerged worktrees. Remove isolated outputs explicitly before deleting their conversation if they are no longer needed.

## Sharing And Security Boundaries

Recipient selection is currently by harness, not by underlying provider/account. Existing conversations retain compatibility with the four known local harnesses unless the user restricts them.

Credential filtering is heuristic. It recognizes common credential field names, credential lines, private-key blocks and several token prefixes; it cannot guarantee removal of arbitrary sensitive data. Literal blocked terms are also supported. Stored originals are unchanged.

Archive filtering does not stop a coding agent from reading sensitive repository files permitted by its own runtime. Native headless approval requests are rejected, not inherited from another executor. Worktree isolation protects ordinary source edits; it does not replace OS/process/network isolation for untrusted agents.

The application instance lock covers one AgentDeck data directory. It does not lock outside editors, external CLIs or separate application data directories. External changes can still race after a final Git check; this is not a general transactional filesystem guarantee.

## Verification And Remaining Work

Regression layers include UI mocks, Rust persistence/Git/process tests, Node protocol tests and provider smoke checks. The current run passed 100 Rust tests, 13 Node runtime/protocol tests and 66 UI tests, including execution configuration, queued-turn changes, cancellation handoff, graph ownership, and explicit artifact removal. The frontend production build also passed. Cross-handle dispatch/deletion exclusion, failed reservation cleanup, immutable execution snapshots, model capability discovery, and pre-dispatch stop/version checks have focused regression coverage. Desktop and 390x844 screenshots were inspected in the final UI pass. Native helper resources are bundled with the sidecar.

Successful Codex and OpenCode CLI smoke checks are narrow protocol tests, not proof of full coding quality or permission enforcement across every provider. OpenCode CLI successfully generated and resumed with `opencode/mimo-v2.6-flash-free`, without repairing the unrelated default-provider credentials. This free model returned "OpenCode's free tier can only be used from within OpenCode" through the current local Server adapter, so native-service generation remains unverified and must not silently fall back to CLI. Free-model CLI is an available path for subsequent mixed-harness acceptance; that acceptance has not yet been performed. No global default-model configuration was changed.

Still outside the completed scope:

- Provider-specific consent is still harness-scoped: the UI does not yet distinguish accounts within one harness.
- Native service processes are still task-scoped and are not pooled across turns.
- Persistent service pooling and broader version/provider integration tests.
- Provider/account-specific data consent and comprehensive sensitive-data classification.
- Exact model-aware tokenization and hard accumulated token/cost limits.
- FTS/semantic retrieval and live shared-history MCP tools for every harness.
- Agent-requested expert delegation, adaptive routing and controlled recursive scheduling.
- Remote A2A interoperability and RLM/RAH evaluation.
- Automated project acceptance commands and measured quality/latency/cost comparisons.

Do not label this implementation as completion of those remaining mechanisms.
