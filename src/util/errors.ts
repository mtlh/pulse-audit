/** Message from any thrown value, used in CLI errors and worker messages. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True for a missing file, which most readers treat as an empty default. */
export function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
