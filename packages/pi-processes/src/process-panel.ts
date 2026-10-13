import { Key, matchesKey, sliceByColumn, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { displayText, statusText } from "./render.js";
import type { ProcessResult } from "./runtime.js";

/** Bounded pages and horizontal navigation, without adding output to model context. */
export class ProcessPanel implements Component {
  private data: ProcessResult;
  private row = 0;
  private column = 0;
  private cursor = 0;
  private readonly previous: number[] = [];

  constructor(
    private readonly read: (cursor: number, tail: boolean) => ProcessResult,
    private readonly close: () => void,
    private readonly redraw: () => void,
    private readonly rows: () => number,
  ) { this.data = read(0, false); }

  invalidate(): void {}
  private get lines(): string[] { return displayText(this.data.output).split(/\r?\n/); }
  private get height(): number { return Math.max(1, Math.min(20, this.rows() - 4)); }

  render(width: number): string[] {
    if (width <= 0) return [];
    const heading = `${this.data.title ?? this.data.session_id.slice(0, 8)} · ${statusText(this.data)}`
      + (this.data.dropped_bytes ? ` · ${this.data.dropped_bytes} bytes omitted` : "");
    return [
      truncateToWidth(displayText(heading), width),
      ...this.lines.slice(this.row, this.row + this.height).map(line =>
        truncateToWidth(sliceByColumn(line, this.column, width), width)),
      truncateToWidth(`Line ${this.row + 1} · column ${this.column} · ${this.data.unread_bytes} bytes remaining`, width),
      truncateToWidth("↑↓ pages · ←→ columns · n next · p previous · t tail · r refresh · Esc close", width),
    ];
  }

  handleInput(input: string): void {
    if (matchesKey(input, Key.escape) || matchesKey(input, Key.enter)) { this.close(); return; }
    if (matchesKey(input, Key.down) || matchesKey(input, Key.pageDown)) this.row = Math.min(Math.max(0, this.lines.length - 1), this.row + this.height);
    else if (matchesKey(input, Key.up) || matchesKey(input, Key.pageUp)) this.row = Math.max(0, this.row - this.height);
    else if (matchesKey(input, Key.left)) this.column = Math.max(0, this.column - 10);
    else if (matchesKey(input, Key.right)) this.column = Math.min(64_000, this.column + 10);
    else if (input === "n" && this.data.next_cursor !== undefined && this.data.unread_bytes) {
      this.previous.push(this.cursor);
      if (this.previous.length > 128) this.previous.shift();
      this.cursor = this.data.next_cursor;
      this.data = this.read(this.cursor, false);
      this.row = this.column = 0;
    } else if (input === "p" && this.previous.length) {
      this.cursor = this.previous.pop()!;
      this.data = this.read(this.cursor, false);
      this.row = this.column = 0;
    } else if (input === "t" || input === "r") {
      this.data = this.read(input === "t" ? 0 : this.cursor, input === "t");
      this.row = this.column = 0;
    }
    this.redraw();
  }
}
