import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { BackgroundProcess, ProcessRuntime } from "./runtime.js";

export const WIDGET_KEY = "pi-processes";

export class ProcessWidget {
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly background: () => BackgroundProcess[],
    private readonly redraw: () => void,
    private readonly now: () => number = Date.now,
  ) {
    // This timer refreshes elapsed time only. Runtime events update membership.
    this.timer = setInterval(() => this.refresh(), 1000);
    this.timer.unref();
  }

  render(width: number): string[] {
    const jobs = this.background();
    if (!jobs.length || width < 1) return [];
    const lines = [
      `Background processes · ${jobs.length}`,
      ...jobs.slice(0, 3).map(job => {
        const seconds = Math.max(0, Math.floor((this.now() - job.started_at) / 1000));
        return `  ${job.session_id.slice(0, 8)} · ${job.tty ? "PTY" : "pipe"} · ${seconds}s · ${job.command_preview}`;
      }),
      ...(jobs.length > 3 ? [`  … ${jobs.length - 3} more running`] : []),
      "/processes: output and stop controls",
    ];
    // Uncolored text inherits the active terminal palette; no cached theme ANSI.
    return lines.map(line => truncateToWidth(line, width));
  }

  refresh(): void {
    try { this.redraw(); } catch { /* terminal teardown must not affect live processes */ }
  }
  invalidate(): void { /* no render cache */ }
  dispose(): void { clearInterval(this.timer); }
}

/** Own only our widget slot. Do not replace an editor, footer, or another widget. */
export class ProcessDisplay {
  private widget?: ProcessWidget;
  private shown = false;
  private disposed = false;
  private readonly completed = new Set<string>();
  private readonly failures = new Set<string>();
  private recent?: string;
  private feedbackTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly ctx: ExtensionContext, private readonly runtime: ProcessRuntime) {}

  sync(): void {
    if (this.disposed || this.ctx.mode !== "tui") return;
    const views = this.runtime.views();
    const ids = new Set(views.map(p => p.session_id));
    for (const id of this.completed) if (!ids.has(id)) this.completed.delete(id);
    for (const id of this.failures) if (!ids.has(id)) this.failures.delete(id);
    let changed = false;
    for (const job of views) {
      if (!job.detached || !job.mode || job.status !== "exited" || this.completed.has(job.session_id)) continue;
      this.completed.add(job.session_id);
      const failed = job.exit_code !== 0 || job.signal !== null || job.timed_out;
      if (failed) this.failures.add(job.session_id);
      this.recent = `${job.title.slice(0, 60)} · ${job.timed_out ? "timed out" : job.signal ? "stopped" : job.exit_code === 0 ? "done" : `exit ${job.exit_code}`}`;
      changed = true;
    }
    if (changed) {
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = setTimeout(() => { this.recent = undefined; this.feedbackTimer = undefined; this.sync(); }, 5000);
      this.feedbackTimer.unref();
    }
    // Pi ui.notify() appends visible conversation rows; completion feedback must
    // remain in our footer slot instead, never accumulating a status transcript.
    try { this.ctx.ui.setStatus("pi-processes-results", this.failures.size
      ? `${this.failures.size} process result(s) need attention · /processes`
      : this.recent ? `${this.recent} · /processes` : undefined); }
    catch { /* display-only feedback */ }
    if (!this.runtime.background().length) {
      this.clear();
      return;
    }
    if (!this.shown) {
      this.ctx.ui.setWidget(WIDGET_KEY, (tui: TUI) => {
        this.widget = new ProcessWidget(() => this.runtime.background(), () => tui.requestRender());
        return this.widget;
      }, { placement: "aboveEditor" });
      this.shown = true;
    }
    this.widget?.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.feedbackTimer);
    this.clear();
    try { this.ctx.ui.setStatus("pi-processes-results", undefined); } catch { /* teardown */ }
  }

  dismiss(id: string): void {
    this.completed.add(id);
    this.failures.delete(id);
    this.recent = undefined;
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = undefined;
    this.sync();
  }

  private clear(): void {
    this.widget?.dispose();
    this.widget = undefined;
    if (this.shown) {
      this.shown = false;
      try { this.ctx.ui.setWidget(WIDGET_KEY, undefined); }
      catch { /* a terminal teardown failure must not prevent process cleanup */ }
    }
  }
}
