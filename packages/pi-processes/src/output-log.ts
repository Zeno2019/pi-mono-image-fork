import { chmodSync, closeSync, mkdtempSync, openSync, readSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Session-private, quota-bound storage. Callers supply an owned ID, never a path. */
export class OutputLogs {
  readonly directory: string;
  private used = 0;
  private closed = false;
  private readonly files = new Map<string, { fd: number; size: number; omitted: number }>();

  constructor(private readonly perProcess = 8 * 1024 * 1024, private readonly total = 32 * 1024 * 1024) {
    this.directory = mkdtempSync(join(tmpdir(), "pi-processes-output-"));
    chmodSync(this.directory, 0o700);
  }

  create(id: string): void {
    if (this.closed || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid output log");
    const fd = openSync(join(this.directory, id), "wx+", 0o600);
    this.files.set(id, { fd, size: 0, omitted: 0 });
  }

  append(id: string, bytes: Buffer): void {
    const file = this.files.get(id);
    if (!file || this.closed) return;
    const size = Math.min(bytes.length, this.perProcess - file.size, this.total - this.used);
    let written = 0;
    try {
      while (written < size) {
        const n = writeSync(file.fd, bytes, written, size - written, file.size + written);
        if (!n) break;
        written += n;
      }
    } catch { /* Disk failures are reported as loss, never as process failures. */ }
    file.size += written;
    this.used += written;
    file.omitted += bytes.length - written;
  }

  read(id: string, cursor: number, maxBytes: number, final = false) {
    const file = this.files.get(id);
    if (!file || this.closed) throw new Error("Process output is no longer retained");
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > file.size) throw new Error("Invalid output cursor");
    const bytes = Buffer.alloc(Math.min(maxBytes + 4, file.size - cursor));
    const count = readSync(file.fd, bytes, 0, bytes.length, cursor);
    let start = 0;
    // A caller can supply a cursor in the middle of a UTF-8 character.
    while (start < count && (bytes[start] & 0xc0) === 0x80) start++;
    let end = Math.min(count, maxBytes);
    while (end > start && end < count && (bytes[end] & 0xc0) === 0x80) end--;
    let lead = end - 1;
    while (lead >= start && (bytes[lead] & 0xc0) === 0x80) lead--;
    if (lead >= start) {
      const byte = bytes[lead];
      const needed = byte >= 0xc2 && byte <= 0xdf ? 2 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xf0 && byte <= 0xf4 ? 4 : 1;
      // While live, hold an incomplete scalar for the next chunk. At real EOF
      // decode malformed trailing bytes once instead of leaving an unadvanceable cursor.
      if (end - lead < needed && !(final && end === count && cursor + count === file.size)) end = lead;
    }
    return {
      output: bytes.subarray(start, end).toString("utf8"),
      next_cursor: cursor + end,
      unread_bytes: file.size - cursor - end,
      dropped_bytes: file.omitted,
    };
  }

  remove(id: string): void {
    const file = this.files.get(id);
    if (!file) return;
    this.files.delete(id);
    this.used -= file.size;
    closeSync(file.fd);
    unlinkSync(join(this.directory, id));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const file of this.files.values()) closeSync(file.fd);
    this.files.clear();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
