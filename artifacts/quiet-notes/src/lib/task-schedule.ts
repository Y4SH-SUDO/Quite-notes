import type { QuietNote } from '../quiet-storage';

export type TaskSchedulePatch = Partial<Pick<QuietNote, 'dueDate' | 'reminderAt' | 'reminderTimezone'>>;

export function updateTaskSchedule(
  note: QuietNote,
  patch: TaskSchedulePatch,
  updatedAt = Date.now(),
): QuietNote {
  const updated: QuietNote = {
    ...note,
    ...patch,
    updatedAt: Math.max(updatedAt, note.updatedAt + 1),
  };
  for (const key of ['dueDate', 'reminderAt', 'reminderTimezone'] as const) {
    if (Object.hasOwn(patch, key) && patch[key] === undefined) delete updated[key];
  }
  return updated;
}
