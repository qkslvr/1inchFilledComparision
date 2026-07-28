function ts(): string {
  return new Date().toISOString();
}

export function log(msg: string): void {
  process.stdout.write(`${ts()} ${msg}\n`);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
  process.stderr.write(`${ts()} ERROR ${msg}${detail}\n`);
}
