/** Takes over `process.stdout` so a test sees what the core writes to the terminal. */
export interface CapturedStdout {
  writes: string[];
  restore(): void;
}

export function captureStdout(isTTY = true): CapturedStdout {
  const writes: string[] = [];
  const stdout = process.stdout;
  const write = stdout.write;
  const tty = Object.getOwnPropertyDescriptor(stdout, "isTTY");
  stdout.write = ((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as typeof stdout.write;
  Object.defineProperty(stdout, "isTTY", { value: isTTY, configurable: true, writable: true });
  return {
    writes,
    restore() {
      stdout.write = write;
      if (tty) Object.defineProperty(stdout, "isTTY", tty);
      else Reflect.deleteProperty(stdout, "isTTY");
    },
  };
}
