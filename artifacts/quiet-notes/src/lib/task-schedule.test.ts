import assert from 'node:assert/strict';
import test from 'node:test';
import { updateTaskSchedule } from './task-schedule.ts';
import type { QuietNote } from '../quiet-storage.ts';

const task: QuietNote = {
  id: 'scheduled-task',
  title: 'Prepare presentation',
  kind: 'task',
  content: '',
  createdAt: 1,
  updatedAt: 2,
  recentlyOpenedAt: 3,
  dueDate: '2026-10-20',
  reminderAt: Date.parse('2026-10-19T09:30:00Z'),
  reminderTimezone: 'Etc/UTC',
};

test('changing a due date preserves the reminder instant and timezone', () => {
  assert.deepEqual(updateTaskSchedule(task, { dueDate: '2026-10-21' }, 10), {
    ...task,
    dueDate: '2026-10-21',
    updatedAt: 10,
  });
});

test('changing the reminder preserves the date-only due date', () => {
  assert.deepEqual(updateTaskSchedule(task, {
    reminderAt: Date.parse('2026-10-19T10:30:00Z'),
    reminderTimezone: 'Etc/UTC',
  }, 10), {
    ...task,
    reminderAt: Date.parse('2026-10-19T10:30:00Z'),
    updatedAt: 10,
  });
});

test('explicitly clearing one schedule field preserves the other', () => {
  const cleared = updateTaskSchedule(task, { dueDate: undefined }, 10);
  assert.equal('dueDate' in cleared, false);
  assert.equal(cleared.reminderAt, task.reminderAt);
  assert.equal(cleared.reminderTimezone, task.reminderTimezone);

  const reminderCleared = updateTaskSchedule(task, {
    reminderAt: undefined,
    reminderTimezone: undefined,
  }, 11);
  assert.equal('reminderAt' in reminderCleared, false);
  assert.equal('reminderTimezone' in reminderCleared, false);
  assert.equal(reminderCleared.dueDate, task.dueDate);
});

test('date-only values remain date-only without timezone conversion', () => {
  assert.equal(updateTaskSchedule(task, { dueDate: '2026-10-20' }, 10).dueDate, '2026-10-20');
});
