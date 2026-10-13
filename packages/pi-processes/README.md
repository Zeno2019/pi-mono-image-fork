# pi-processes

Keep long-running commands out of Pi's critical path without losing control of them.

`pi-processes` adds task-aware process execution to Pi on macOS and Linux. Run a command in the foreground, overlap a finite background job with independent work, or keep a service running. Background results arrive automatically; humans can inspect and stop processes without asking the model.

- **Fast pipe path:** ordinary commands use Node's native pipes; the native PTY module loads only when requested.
- **Interactive when needed:** every non-empty PTY input write requires your approval, including control characters.
- **Always visible:** a persistent TUI widget shows live background commands, session ID prefixes, pipe/PTY mode, and elapsed time.
- **No polling loops:** explicit background mode delivers bounded output at a safe model boundary and resumes the requesting task.
- **Compact review:** four output lines by default, bounded expansion, and a paged `/processes` viewer with horizontal scrolling.
- **Bounded execution:** eight concurrent processes, bounded output and retained sessions, configurable timeouts, and group cleanup.
- **Provider-neutral:** public Pi tools and structured results work with direct calls and codemode.

This is a process runtime, **not a sandbox or subagent engine**. It neither installs provider overrides nor changes Pi's existing `bash` tool.

The tool names and lifecycle are inspired by [OpenAI Codex](https://github.com/openai/codex). The runtime is independently implemented; Codex's sandbox and approval machinery are not ported.

## Install

The explicit modes, output/wait tools and process panel described below are unreleased. Published 0.2.0 has the legacy interface; use a local checkout to try these changes.

Install the package:

```bash
pi install npm:pi-processes@0.2.0
```

For DCG startup protection, also install the companion guard release:

```bash
pi install npm:pi-dcg@0.4.0
```

`pi-dcg` requires a separately installed `dcg` executable. Its default bridge failure policy is fail-open; start Pi with `PI_DCG_ON_ERROR=block` to block startup when checks cannot run.

From a local monorepo checkout:

```bash
npm install
pi -e ./packages/pi-processes
```

Requirements: Node >=22.19.0, macOS or Linux, and a Pi host. Public API contracts are tested against Pi 1.1.0. `node-pty` 1.2.0-beta.15 is an optional native dependency: pipes work without it, but `tty:true` fails explicitly if its binding cannot load. This exact upstream prerelease fixes the macOS helper's missing execute permission in stable 1.1.0; no runtime permission repair is needed. A source build may need a C/C++ toolchain, Python, and Node headers. Review npm's lifecycle-script policy if native installation is disabled.

Do not load another extension that registers `exec_command` or `write_stdin` at the same time.

## Tools

### Choose by dependency, not command duration

| Mode | Use when | Result |
| --- | --- | --- |
| `foreground` (default) | The next action needs the result, or no useful independent work remains | Wait for the final result; no extra completion message |
| `background` | Finite work can overlap independent actions | Return promptly; automatically deliver final output to the current task |
| `service` | A server, watcher or other indefinite process should stay running | Return promptly; no automatic completion turn |

Do not edit a command's inputs while validation reads them. Re-run validation after relevant edits. `input_changes_observed` is a conservative warning that Pi's `edit`, `write` or `apply_patch` tools ran during the command; it is not a filesystem snapshot and cannot detect external changes.

Background mode authorizes additional provider usage. Results are batched into the next safe continuation, or one idle continuation when ready. They are labeled as untrusted command data, stored in the normal session transcript with `display:false`, and not printed as process bookkeeping. Direct final-result observations can consume delivery. A new user prompt, queued direction change, or abort disarms older task subscriptions without stopping the jobs. Use `process_output` or `process_wait` if you still need their results. Status listing alone does not acknowledge output.

If no independent work remains, use one event-driven wait or end the response and allow completion to resume the task. Do not repeatedly poll, sleep, or read logs just to check status. Service startup is not readiness: inspect useful output or perform an explicit readiness check.

### `exec_command`

```json
{"cmd":"npm test","mode":"background","title":"Run tests"}
```

| Argument | Default | Meaning |
| --- | --- | --- |
| `cmd` | required | Shell command, at most 65,536 characters |
| `mode` | `foreground` | Foreground, background, or service intent |
| `title` | command preview in UI | Short human-readable title, at most 160 characters; never include credentials |
| `workdir` | Pi cwd | Directory, resolved relative to Pi cwd |
| `tty` | `false` | Allocate a 120×40 PTY instead of pipes |
| `yield_time_ms` | omitted | Legacy attachment window, capped at 30 seconds; zero returns immediately. Cannot combine with explicit modes |
| `max_output_tokens` | `4000` | Approximate output budget: four UTF-8 bytes per requested token, capped at 64,000 bytes; also bounds the completion tail when enabled |
| `timeout_ms` | `1800000` / service `86400000` | Process lifetime limit, 100 ms to 24 hours; foreground returns on exit/termination |
| `notify_on_exit` | `false` | Request one follow-up turn when a background process completes |
| `completion_mode` | omitted | Opt in to output delivery using `nextTurn`, `followUp`, or `steer`; overrides `notify_on_exit` |

Explicit modes cannot combine with legacy `notify_on_exit:true`, `completion_mode`, or `yield_time_ms`. A legacy short wait without completion options is silent on exit. Do not append `&`: the runtime owns the command's lifetime and process group.

Initial background results include `completion_delivery:"automatic"` only when a task subscription is armed; otherwise they report `"manual"`. Running foreground/service results report `"manual"`. This is also available to codemode, not only in explanatory text. A background job that finishes before startup returns still has coordinated delivery: direct final observations consume it, but a discarded nested result cannot silently lose it. If task replacement or the 32-subscription ceiling prevents arming, use one `process_wait` when the result is required. Retained-record admission also fails safely when all slots are live or pinned by readers instead of exceeding the storage/record cap.

Queued user input releases an attached foreground wait with `status:"running"` and `wait_status:"interrupted_by_input"` without killing the command. Handle the new direction before waiting again. Explicit tool cancellation still terminates a command during its initial call.

Linux uses `/bin/bash --noprofile --norc -c`; macOS uses `/bin/zsh -f -c`. Neither uses login-shell initialization. Commands inherit Pi's environment and filesystem/network permissions. Pipe stdin is closed. stdout/stderr are merged by arrival, not guaranteed to preserve ordering between streams.

### `write_stdin`

```json
{"session_id":"<PTY id>","chars":"approved input\n"}
```

Empty `chars` polls without input approval. Non-empty `chars` requires `tty:true` and a separate confirmation for that exact input. Input is capped at 4,096 characters. Control characters are shown escaped in the prompt. TUI and RPC confirmation are supported; print/JSON sessions block non-empty writes. Dialog failure, rejection, timeout, or cancellation blocks the write.

Empty polls default to one second and cap at five minutes. Input writes default to 250 ms and cap at 30 seconds. `max_output_tokens` uses the same approximate byte budget as startup.

Calls for the same process serialize, including input approval; different process sessions run concurrently. Each poll consumes the next output segment. Cancelling a poll leaves the process running; use `process_kill` to stop it. Cancelling the initial `exec_command` wait terminates that newly created process.

### `process_output`

```json
{"session_id":"<id>","cursor":0,"max_output_tokens":4000}
```

Read useful partial or final output immediately. Reads are non-consuming: use the returned `next_cursor` for incremental segments without interfering with other readers, the model completion tail or the UI. `cursor` counts raw bytes before terminal sanitization. `dropped_bytes` reports bytes not stored because of log quotas or disk failures; `unread_bytes` counts remaining retained bytes.

The transport decodes stdout/stderr as UTF-8 before retention; malformed bytes become replacement characters. Cursors count this decoded UTF-8 stream, not a binary-exact original byte stream.

Set `tail:true` to inspect the latest output, including after log quota exhaustion. Tail reads have `output_scope:"tail"` and no cursor; do not combine them with a nonzero cursor. Normal reads have `output_scope:"log"`.

Inside codemode, a script can discard a nested result. Set `acknowledge:true` when the script intentionally handles the final result and should consume automatic delivery; otherwise the coordinator will still deliver it to the model. Direct finalized reads acknowledge only final results with no unread retained bytes.

### `process_wait`

```json
{"session_ids":["<id-a>","<id-b>"],"until":"all","timeout_ms":1800000}
```

One event-driven dependency wait for up to eight processes. `until` is `all` (default) or `any`. The wait returns immediately when its condition is met, at its deadline, or when user input is queued. `wait_status` is `completed`, `deadline`, or `interrupted_by_input`. Tool cancellation leaves processes running.

Output budgets apply across the selected processes. Results are non-consuming log reads, so large output can require `process_output` cursors or a tail read. Nested calls support the same explicit `acknowledge` contract. Do independent work before waiting; do not implement a repeated model polling loop.

### `process_list` and `process_kill`

`process_list({})` lists retained IDs and status without consuming output. `process_kill({"session_id":"..."})` sends SIGTERM to the owned POSIX process group, escalates to SIGKILL after 500 ms, and returns remaining bounded output. You cannot supply an arbitrary PID.

### Results and retention

Every execution/poll result includes:

```json
{
  "session_id":"<opaque UUID>",
  "status":"running",
  "exit_code":null,
  "signal":null,
  "output":"...",
  "dropped_bytes":0,
  "unread_bytes":0,
  "timed_out":false
}
```

IDs are strings, not Codex's numeric IDs; this is an inspired API, not a drop-in Codex protocol. Terminal escape/control sequences are removed from returned output. Nonzero exits remain process data, not a failed polling operation.

Each process retains the latest 1 MiB of unread legacy polling output, an independent 64,000-byte latest-output tail, and up to 8 MiB of raw output in private temporary storage. Disk storage is capped at 32 MiB per runtime; overflow is explicit, not a complete archive. Temporary directories/files use 0700/0600 permissions. At most 32 records are retained; older completed records are evicted as new jobs start. Output logs are removed on eviction and orderly teardown. SIGKILL/crash can leave temporary logs behind; there is no restart recovery. See SECURITY for the sensitive-data implications.

Ordinary foreground execution and legacy short waits without completion options create no completion message. Explicit `notify_on_exit:true` retains the legacy metadata-only follow-up. Explicit background mode delivers bounded output through the task coordinator. Completion context never attaches command or PTY input arguments, although output can echo either.

### Legacy completion options

For compatibility, the earlier output-delivery interface remains available. Prefer explicit background mode for task scoping, batching and observation coordination:

```json
{"cmd":"npm test","yield_time_ms":1000,"completion_mode":"steer","max_output_tokens":4000}
```

| Mode | While Pi is working | While Pi is idle |
| --- | --- | --- |
| `nextTurn` | Wait for a new prompt; do not inject into the current run's tool continuations | Do not start a model turn |
| `followUp` | Deliver when the current agent run would otherwise stop | Start a model turn |
| `steer` | Deliver at the next safe model boundary, after the current turn and its tool batch complete | Start a model turn |

Steering does not modify an inference already in progress, cancel tools, or bypass input approval. `completion_mode` takes precedence over `notify_on_exit`, including `nextTurn` overriding a legacy wake request. `followUp` and `steer` can incur additional model usage.

The one-shot completion message includes the process ID, exit status, signal, timeout flag, and a sanitized **tail of all output received**, including output already returned by startup or polling. The tail uses the initial `max_output_tokens` byte budget (16,000 bytes by default; maximum 64,000 bytes). `output_scope:"completion_tail"` identifies it, and `dropped_bytes` counts raw output bytes omitted from this tail, independently of polling overflow. UTF-8 characters are kept whole.

Completion capture is separate from legacy polling and non-consuming log reads. It does not reset their loss counters. Legacy explicit options retain their timing and duplicate-tail behavior; they are not task-scoped. All completion messages are hidden from the visible conversation.

Pushed output is explicitly labeled as untrusted command data, not instructions. The extension does not attach command or input arguments, but output can echo either and can contain secrets or prompt injection. Opt in only for output you intend to send to your model provider and store in Pi's normal session transcript. Shutdown and reload suppress completion delivery from processes they terminate.

### Background process widget

In interactive Pi, live background processes appear above the editor:

```text
Background processes · 2
  7036d2a5 · pipe · 12s · npm test
  b50d91ce · PTY · 4s · read -r answer
/processes: output and stop controls
```

Only processes whose initial call returned `running` appear. Foreground calls and completed records do not occupy the widget. Membership changes immediately on process exit, kill, or timeout, without polling or a model turn. Elapsed time refreshes once per second while jobs remain. The widget disappears when the last job exits and clears on reload, shutdown, or session replacement.

Each command preview is bounded to the first 256 UTF-16 code units, escapes terminal controls and direction-changing Unicode characters, and truncates to the available terminal width. It is a preview, not a full command or safety decision. Commands can contain secrets; do not place credentials in command arguments. No process output or submitted PTY input is displayed or consumed by the widget.

The widget shows at most three process rows plus an overflow count. Explicit-mode completion gives brief local feedback; failed results leave an attention status until inspected. Use `/processes` to view output or stop a job without a model call. The viewer supports pages, horizontal scrolling, next/previous cursor segments, refresh, and latest-output tails. Other extensions' widgets, editor, and footer remain unchanged. RPC, print, and JSON modes do not create terminal components; their structured tools and automatic result delivery still work. Print/JSON callers must keep the host alive for idle auto-resume, or use foreground/`process_wait` before exiting.

Opening the process panel does not change the model task. Navigating to another session-tree branch disarms task subscriptions; retained process controls remain available.

Tool results, including empty legacy `write_stdin` polls, show status and loss counts plus the first four output lines. Expansion shows at most 40 lines; long lines are clipped to terminal width. Model output budgets are independent of this display limit. Use the process panel for full retained segments and long-line navigation.

Completion feedback uses a footer status, not `ui.notify()` or visible conversation entries. Successful completion fades after five seconds; failed-result attention remains until inspected. Carriage-return progress and tabs are normalized for display without changing model output or raw retained logs.

## Command policy

Enable `pi-dcg` 0.4.0 or newer alongside this extension for DCG startup checks. It checks `exec_command.cmd` in the resolved `workdir` and seals startup arguments against later mutations. It also keeps its existing `bash` and user-shell coverage. Earlier `pi-dcg` releases do not check `exec_command`.

DCG is optional and inherits its configured fail-open/fail-closed policy. Set `PI_DCG_ON_ERROR=block` for bridge failures to block startup. Without a guard extension, startup follows Pi's normal local-tool behavior; this package does not add a startup confirmation.

**DCG cannot safely validate partial interactive input.** The per-write confirmation is a separate human decision, not a DCG allow decision. Approving input can execute destructive commands or alter a shell's state. Tool hooks remain applicable to direct and nested/codemode calls, but hooks written only for `bash` do not automatically cover these tools. The Pi 1.1.0 earlier-input-object replacement limitation described in pi-dcg also applies.

See [SECURITY.md](SECURITY.md) for process-group and isolation limitations.

## Development and smoke test

From the repository root:

```bash
npm run -w packages/pi-processes check
npm test -w packages/pi-processes
npm run -w packages/pi-processes pack:dry-run
```

The tests execute real pipe and PTY processes without model credentials, and exercise a real Pi session with a synthetic provider, codemode, and DCG decisions.

Manual smoke test on both platforms:

1. Load this package and `pi-dcg` in a disposable directory with `PI_DCG_ON_ERROR=block`.
2. Start `printf 'ready\n'; sleep 3; printf 'done\n'` with a short initial wait. Continue other work and poll the returned ID.
3. Start `read -r answer; printf '%s\n' "$answer"` with `tty:true`. Reject one input write, then approve `hello\n`. Verify only the approved write reaches the process.
4. Start `sleep 60 & wait`, stop its ID, and verify both shell and child exit.
5. Start another sleeper, then reload or switch sessions. Verify it exits and its old ID is unavailable.
6. Request `notify_on_exit:true` once. Verify one metadata-only completion follow-up. Repeat without it and verify no unsolicited model turn.
7. Repeat input rejection/approval with an RPC client that implements Pi's extension UI protocol.
8. In interactive Pi, start two sleepers with short initial waits. Verify both appear above the editor while Pi is idle and their elapsed times advance. Kill one and verify the count drops. Let the other finish without polling and verify the widget disappears. Repeat with a foreground command and verify no widget appears.
9. While a background process is visible, resize the terminal and switch between light, dark, and system themes. Verify lines fit, the editor remains usable, and other extensions' widgets remain present. Repeat in regular and fullscreen modes.
10. Start `sleep 3; printf 'test failed\n'; exit 7` with `yield_time_ms:0` and `completion_mode:"steer"`. Leave Pi idle. Verify the next model turn receives the exit code and output without polling. Poll afterward and verify the output remains available. Repeat while Pi is doing other work, then compare with `followUp` and `nextTurn`.

The widget uses public Pi UI APIs. No editor/footer replacement or private Pi API patch is used.

Additional smoke checks for this unreleased interface:

1. Start a finite background test with a title, then do independent read-only work. Verify the result reaches the next safe continuation without polling or a visible JSON completion card.
2. Start two independent foreground commands in one tool batch. Verify their lifetimes overlap; do not use concurrently mutating validation inputs.
3. Start an indefinite service. Verify it returns promptly, stays inspectable in `/processes`, and does not auto-resume on exit or claim readiness.
4. Run a command with hundreds of output lines, then use a legacy empty `write_stdin` poll. Verify four collapsed output lines, bounded expansion, status/loss counts and narrow-terminal clipping.
5. Inspect it through `/processes`. Verify vertical pages, horizontal columns, next/previous log segments, tail and refresh. Confirm this makes no model request and does not consume tool output.
6. Queue a steering message during a long foreground attachment or `process_wait`. Verify prompt release without process termination. Change task or session-tree branch before background completion and verify no stale wake.
7. Repeat a nested wait in codemode while discarding its result; verify automatic model delivery still occurs. Repeat with `acknowledge:true` while handling the result and verify no duplicate.

Automated tests use a scripted provider to verify Pi scheduling and serialization without credentials. They prove execution/delivery contracts, not that every model will choose optimal parallel work. For a live-model acceptance pass, compare independent work before waiting, empty-poll counts, duplicate reports, result latency, correctness after edits, and task time/token use across the models you use.

To check another installed SDK without using credentials or live inference:

```bash
node --import tsx packages/pi-processes/tests/host-smoke.mjs /path/to/installed/pi-coding-agent/dist/index.js
```
