import { registerPlugin } from '@capacitor/core';

export type BackupFolder = {
  uri: string;
  name: string;
};

type OfflineBackupPlugin = {
  selectFolder(): Promise<{ canceled?: boolean; uri?: string; name?: string }>;
  selectDocument(): Promise<{
    canceled?: boolean;
    name?: string;
    mimeType?: string;
    size?: number;
    base64?: string;
  }>;
  getFolder(): Promise<{ uri?: string; name?: string }>;
  writeBackup(options: { content: string }): Promise<{ name: string; uri: string; writtenAt: number }>;
};

export const offlineBackupPlugin = registerPlugin<OfflineBackupPlugin>('OfflineBackup');

export type AutomaticBackupStatus =
  | { kind: 'pending'; message: string }
  | { kind: 'success'; message: string; writtenAt: number }
  | { kind: 'error'; message: string };

export class AutomaticBackupRunner {
  private requestedRevision = 0;
  private completedRevision = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private readonly createSnapshot: () => Promise<string>;
  private readonly writeSnapshot: (content: string) => Promise<void>;
  private readonly onStatus: (status: AutomaticBackupStatus) => void;
  private readonly debounceMs: number;

  constructor(
    createSnapshot: () => Promise<string>,
    writeSnapshot: (content: string) => Promise<void>,
    onStatus: (status: AutomaticBackupStatus) => void,
    debounceMs = 900,
  ) {
    this.createSnapshot = createSnapshot;
    this.writeSnapshot = writeSnapshot;
    this.onStatus = onStatus;
    this.debounceMs = debounceMs;
  }

  request(): void {
    this.requestedRevision += 1;
    this.onStatus({ kind: 'pending', message: 'Backup pending — waiting for recent changes to finish saving.' });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) {
      this.running = this.runPending().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  private async runPending(): Promise<void> {
    while (this.completedRevision < this.requestedRevision) {
      const revision = this.requestedRevision;
      try {
        const snapshot = await this.createSnapshot();
        if (revision !== this.requestedRevision) continue;
        await this.writeSnapshot(snapshot);
        this.completedRevision = revision;
        if (revision !== this.requestedRevision) continue;
        this.onStatus({
          kind: 'success',
          message: `Backed up just now (${new Date().toLocaleString()}).`,
          writtenAt: Date.now(),
        });
      } catch (error) {
        this.onStatus({
          kind: 'error',
          message: error instanceof Error ? error.message : 'The automatic backup failed. Check the selected folder and try again.',
        });
        if (revision < this.requestedRevision) continue;
        return;
      }
    }
  }
}

export function statusForSavedBackup(value: string | null): AutomaticBackupStatus | null {
  if (!value) return null;
  try {
    const status = JSON.parse(value) as AutomaticBackupStatus;
    if (
      (status.kind === 'success' && typeof status.writtenAt === 'number' && typeof status.message === 'string')
      || (status.kind === 'error' && typeof status.message === 'string')
    ) return status;
    return null;
  } catch {
    return null;
  }
}
