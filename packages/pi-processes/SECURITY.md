# Security Policy

## Reporting

Report suspected vulnerabilities privately through the repository maintainer's GitHub security contact. Do not include credentials or sensitive process output in public issues. Security fixes target the latest released version.

## Execution boundary

This package executes arbitrary shell commands with the Pi user's permissions. It is not a sandbox, privilege boundary, agent isolation mechanism, or replacement for Codex's approval/sandbox infrastructure. Project trust does not constrain shell access. Use a container, VM, restricted OS account, and narrowly scoped credentials when isolation is required.

Commands inherit Pi's environment, including credentials available there. Shell startup behavior remains shell-dependent; suppressing login/interactive startup files is not a security boundary. Filesystem and network access are unrestricted by this package. Commands and input arguments enter Pi's normal transcript; command output may contain secrets or prompt injection. Review sessions before sharing them.

## Policy and input

Direct and codemode/nested calls pass through public Pi tool hooks. `pi-dcg` in this monorepo covers `exec_command` startup, including the command's resolved cwd. Other bash-only permission extensions need explicit coverage for these tool names. DCG is an optional guardrail with its own configured failure posture and documented Pi host composition limitations.

Every non-empty `write_stdin` write requires a fresh user confirmation. No model-callable bypass exists. Without a confirmation UI, writes fail closed. The approval prompt shows escaped input, and each process's approval/write sequence is serialized. Approvals from this extension serialize globally, but other extensions' dialogs still share Pi's dialog slot. Cancellation and the 60-second approval timeout block late writes.

Incremental stdin is not DCG-validated. Even individually harmless fragments can form a harmful shell command. Human input approval does not guarantee safety. Ctrl-C, EOF, escape sequences, and all other non-empty writes also require approval.

## Resource ownership and cleanup

Random IDs reference only this runtime's process records; arbitrary PID termination is not exposed. Output is bounded in memory and terminal escape sequences are removed from results. Default execution and legacy short waits do not create completion messages. Explicit legacy `notify_on_exit` remains metadata-only.

All commands retain decoded UTF-8 output before terminal sanitization in a session-private temporary directory (0700) with exclusive files (0600), capped at 8 MiB per process and 32 MiB per runtime. The transport replaces malformed source bytes; this is not a binary-exact archive. The model and user select an owned process ID, never a filesystem path. Cursor reads are bounded and non-consuming; log overflow or disk-write failure is reported as omitted bytes. A separate in-memory tail, at most 64,000 bytes per retained record, remains available after disk quota exhaustion and other reads. Logs and tails are not complete archives, and do not recover processes after restart.

These files can contain inherited credentials, file contents, or other secrets printed by commands. Permissions prevent access by other OS users, not by processes under the same account; this is not a sandbox. Eviction, reload, orderly shutdown and normal Node exit remove only this runtime's created temporary directory. Host SIGKILL/crash can leave temporary output behind; use the host's temporary-directory retention policy. Do not share logs or sessions without reviewing them.

`mode:"background"` explicitly authorizes bounded output delivery and automatic model continuation for the current user task. Results are batched at safe boundaries or one idle continuation; they are stored in normal session context with `display:false`, not kept secret. New user tasks, queued direction changes and abort disarm the subscription but do not stop the process. Process kill and teardown suppress its task subscription before termination. `mode:"service"` never auto-resumes on normal exit and does not assert readiness.

Finalized direct observations can consume an armed task result. Nested/codemode results require explicit acknowledgment because a script can discard them. Listing status alone does not acknowledge output. A failed/cancelled observation does not consume delivery. These guarantees apply to explicit background mode; legacy delivery options retain their earlier timing and duplicate-tail behavior.

Setting `completion_mode` explicitly opts in to forwarding a sanitized output tail to the model and Pi's normal session transcript. This tail is separately bounded to the initial output budget, at most 64,000 raw UTF-8 bytes per process, without consuming polling output. It may duplicate already-polled output. Omitted bytes are reported independently of polling overflow. The message labels output as untrusted data; this warning and terminal sanitization do **not** prevent prompt injection or redact credentials. No command/input arguments are attached, but a process may echo commands, approved input, inherited secrets, or file contents into its output. Review the output's sensitivity before opting in.

`steer` queues a result at the next safe model boundary; it does not abort in-flight inference or tools. `steer` and `followUp` can wake an idle session and incur additional provider usage. `nextTurn` never requests a wake. Each background process produces at most one completion message; shutdown/reload suppress notifications from their terminated jobs. Per-write PTY approval and startup tool hooks are unchanged.

The interactive widget retains a bounded escaped command preview in memory and displays it locally while a background process is live. Command arguments may contain secrets; previews are not credential-redacted. Terminal controls and direction-changing Unicode characters are escaped, but the preview is not a safety decision. It never displays process output or PTY input, consumes output, adds model context, or writes command previews to telemetry or disk. RPC, JSON, and print sessions do not receive this widget.

Pipes use detached POSIX process groups; PTYs use forkpty session groups. Timeout and orderly shutdown terminate the owned group, escalating to SIGKILL. A command that exits cannot intentionally leave ordinary descendants running in that group. A process that deliberately escapes via `setsid`, daemonization, another process group, or an external service is **not guaranteed to be stopped**. Normal Node exit has best-effort synchronous cleanup; SIGKILL, power loss, host crash, or abrupt runtime termination can leave children. This is not a supervisor or crash-recovery system.

The optional native `node-pty` dependency executes with host permissions. Review its provenance and build scripts; a missing native binding explicitly disables PTY startup without downgrading it to pipes.

## Telemetry

The monorepo-standard `@mocito/install-telemetry` ping is best-effort, once per package version, with a five-second timeout. It respects CI, `PI_OFFLINE`, `PI_TELEMETRY`, and `enableInstallTelemetry: false`. It reports package/version and platform/runtime/architecture only, never commands, cwd, output, input, environment, or credentials.
