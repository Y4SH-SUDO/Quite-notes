import type { QuietNote } from '../quiet-storage.ts';

export type NoteFlag = 'pinned' | 'favorite';
export type NoteFlagValues = Partial<Record<NoteFlag, boolean>>;
export type PersistNoteFlags = (noteId: string, flags: NoteFlagValues) => Promise<unknown>;

export type PendingNoteFlagSave = {
  note: QuietNote;
  flags: NoteFlagValues;
  revision: number;
  attempt: number;
  status: 'saving' | 'error';
  error?: string;
};

export function noteWithPendingFlags(note: QuietNote, pending: PendingNoteFlagSave): QuietNote {
  return {
    ...note,
    ...pending.flags,
    updatedAt: Math.max(note.updatedAt + 1, pending.note.updatedAt),
  };
}

async function persistNoteAction(
  noteId: string,
  flags: NoteFlagValues,
  persist: PersistNoteFlags,
): Promise<string | null> {
  try {
    await persist(noteId, flags);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Unknown storage error.';
  }
}

export class NoteWriteQueue {
  private readonly queues = new Map<string, Promise<void>>();

  run<T>(noteId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(noteId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.queues.set(noteId, settled);
    void settled.then(() => {
      if (this.queues.get(noteId) === settled) this.queues.delete(noteId);
    });
    return result;
  }
}

export const noteWriteQueue = new NoteWriteQueue();

export class NoteFlagSaveCoordinator {
  private readonly pending = new Map<string, PendingNoteFlagSave>();
  private readonly revisions = new Map<string, number>();

  getPending(): PendingNoteFlagSave[] {
    return Array.from(this.pending.values());
  }

  getPendingNote(noteId: string): QuietNote | undefined {
    return this.pending.get(noteId)?.note;
  }

  getPendingSave(noteId: string): PendingNoteFlagSave | undefined {
    return this.pending.get(noteId);
  }

  hasPending(noteId: string): boolean {
    return this.pending.has(noteId);
  }

  getRevision(noteId: string): number {
    return this.revisions.get(noteId) ?? 0;
  }

  canApplyRemote(noteId: string, allowPending: boolean, expectedRevision?: number): boolean {
    if (expectedRevision !== undefined && this.getRevision(noteId) !== expectedRevision) return false;
    return allowPending || !this.hasPending(noteId);
  }

  clear(noteId: string, expectedRevision?: number): boolean {
    if (expectedRevision !== undefined && this.getRevision(noteId) !== expectedRevision) return false;
    this.revisions.set(noteId, this.getRevision(noteId) + 1);
    this.pending.delete(noteId);
    return true;
  }

  async save(note: QuietNote, flag: NoteFlag, persist: PersistNoteFlags): Promise<void> {
    const revision = (this.revisions.get(note.id) ?? 0) + 1;
    this.revisions.set(note.id, revision);
    const previousFlags = this.pending.get(note.id)?.flags ?? {};
    const entry: PendingNoteFlagSave = {
      note,
      flags: { ...previousFlags, [flag]: note[flag] === true },
      revision,
      attempt: 1,
      status: 'saving',
    };
    this.pending.set(note.id, entry);
    await this.persistEntry(entry, persist);
  }

  async retry(noteId: string, persist: PersistNoteFlags): Promise<void> {
    const current = this.pending.get(noteId);
    if (!current || current.status !== 'error') return;
    const entry: PendingNoteFlagSave = {
      ...current,
      attempt: current.attempt + 1,
      status: 'saving',
      error: undefined,
    };
    this.pending.set(noteId, entry);
    await this.persistEntry(entry, persist);
  }

  private async persistEntry(entry: PendingNoteFlagSave, persist: PersistNoteFlags): Promise<void> {
    const error = await persistNoteAction(
      entry.note.id,
      entry.flags,
      persist,
    );
    const current = this.pending.get(entry.note.id);
    if (current?.revision !== entry.revision || current.attempt !== entry.attempt) return;
    if (error) {
      this.pending.set(entry.note.id, { ...current, status: 'error', error });
    } else {
      this.pending.delete(entry.note.id);
    }
  }

}

export const noteFlagSaveCoordinator = new NoteFlagSaveCoordinator();
