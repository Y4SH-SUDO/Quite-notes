import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { QuietNote } from '../quiet-storage';

export type ReminderPermission = 'granted' | 'prompt' | 'denied' | 'unsupported';
export type BrowserNotificationResult = {
  status: 'shown' | 'prompt' | 'denied' | 'unsupported' | 'failed';
  method?: 'service-worker' | 'constructor';
  diagnostics: string[];
};

type UpcomingReminder = {
  note: QuietNote;
  at: number;
  id: number;
};

export type ReminderDiagnostic = (message: string) => void;

const browserTimers = new Map<number, ReturnType<typeof setTimeout>>();
const MAX_TIMEOUT = 2_147_000_000;
const FIRED_REMINDERS_KEY = 'quiet-notes-fired-reminders';
let notificationConstructorFailure: string | undefined;
let notificationConstructorFailureApi: typeof Notification | undefined;
let serviceWorkerRegistrationFailure: string | undefined;
let serviceWorkerShowFailure: string | undefined;

export function reminderId(noteId: string, reminderAt: number): number {
  let hash = 2166136261;
  const value = `${noteId}:${reminderAt}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function upcomingReminders(notes: QuietNote[], now = Date.now()): UpcomingReminder[] {
  return notes.flatMap(note => (
    note.kind === 'task' && note.reminderAt !== undefined && note.reminderAt > now
      ? [{ note, at: note.reminderAt, id: reminderId(note.id, note.reminderAt) }]
      : []
  ));
}

export async function currentReminderPermission(): Promise<ReminderPermission> {
  if (Capacitor.isNativePlatform()) {
    try {
      const permission = await LocalNotifications.checkPermissions();
      if (permission.display === 'granted') return 'granted';
      if (permission.display === 'prompt' || permission.display === 'prompt-with-rationale') return 'prompt';
      return 'denied';
    } catch (error) {
      console.error('Could not check native notification permission.', error);
      return 'unsupported';
    }
  }
  const NotificationApi = getNotificationApi();
  if (!NotificationApi) return 'unsupported';
  try {
    if (NotificationApi.permission === 'granted') return 'granted';
    return NotificationApi.permission === 'default' ? 'prompt' : 'denied';
  } catch (error) {
    console.error('Could not check browser notification permission.', error);
    return 'unsupported';
  }
}

export async function requestReminderPermission(): Promise<ReminderPermission> {
  if (Capacitor.isNativePlatform()) {
    try {
      const current = await LocalNotifications.checkPermissions();
      const permission = current.display === 'granted'
        ? current
        : await LocalNotifications.requestPermissions();
      return permission.display === 'granted' ? 'granted' : 'denied';
    } catch (error) {
      console.error('Could not request native notification permission.', error);
      return 'unsupported';
    }
  }
  const NotificationApi = getNotificationApi();
  if (!NotificationApi) return 'unsupported';
  try {
    const permission = NotificationApi.permission === 'granted'
      ? NotificationApi.permission
      : await NotificationApi.requestPermission();
    return permission === 'granted' ? 'granted' : 'denied';
  } catch (error) {
    console.error('Could not request browser notification permission.', error);
    return 'unsupported';
  }
}

function getNotificationApi(): typeof Notification | undefined {
  return typeof globalThis.Notification === 'function' ? globalThis.Notification : undefined;
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `Non-Error exception: ${String(error)}`;
}

async function readyNotificationRegistration(diagnostics: string[]): Promise<ServiceWorkerRegistration | undefined> {
  if (serviceWorkerRegistrationFailure) {
    diagnostics.push(`Service worker registration not retried; previously unsupported: ${serviceWorkerRegistrationFailure}`);
    return undefined;
  }
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      diagnostics.push('Service workers: unsupported (navigator.serviceWorker is unavailable).');
      return undefined;
    }
    const pageUrl = typeof location === 'undefined' ? 'http://localhost/' : location.href;
    const basePath = import.meta.env?.BASE_URL ?? '/';
    const baseUrl = new URL(basePath, pageUrl);
    const workerUrl = new URL('quiet-notes-sw.js', baseUrl);
    const scopeUrl = baseUrl;
    let registration = await navigator.serviceWorker.getRegistration(scopeUrl.href);
    if (!registration) {
      diagnostics.push(`Service workers: no registration found for ${scopeUrl.href}; registering ${workerUrl.href}.`);
      registration = await navigator.serviceWorker.register(workerUrl.href, { scope: scopeUrl.pathname });
    } else {
      diagnostics.push(`Service workers: registration found for ${registration.scope}.`);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let ready: ServiceWorkerRegistration;
    try {
      ready = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Timed out waiting for navigator.serviceWorker.ready.')), 8_000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    registration = ready;
    const activeState = registration.active?.state ?? 'none';
    diagnostics.push(`Service worker readiness: ready; active worker state: ${activeState}; showNotification: ${typeof registration.showNotification === 'function' ? 'available' : 'unavailable'}.`);
    return registration;
  } catch (error) {
    const details = errorDetails(error);
    diagnostics.push(`Service worker registration/readiness failed: ${details}`);
    if (error instanceof DOMException && ['NotAllowedError', 'NotSupportedError', 'SecurityError'].includes(error.name)) {
      serviceWorkerRegistrationFailure = details;
      diagnostics.push('This service-worker registration failure will not be retried during this app session.');
    }
    return undefined;
  }
}

export async function showBrowserNotification(
  title: string,
  options: NotificationOptions,
): Promise<BrowserNotificationResult> {
  const diagnostics: string[] = [];
  const NotificationApi = getNotificationApi();
  if (notificationConstructorFailureApi !== NotificationApi) {
    notificationConstructorFailure = undefined;
    notificationConstructorFailureApi = NotificationApi;
  }
  diagnostics.push(`Origin: ${typeof location === 'undefined' ? 'unavailable' : location.origin}.`);
  diagnostics.push(`Secure context: ${typeof isSecureContext === 'boolean' ? String(isSecureContext) : 'unknown'}.`);
  diagnostics.push(`Notification API: ${NotificationApi ? 'available' : 'unavailable'}.`);
  if (!NotificationApi) {
    diagnostics.push('Notification API unavailable; neither service-worker permission nor constructor delivery can be requested.');
    return { status: 'unsupported', diagnostics };
  }
  try {
    diagnostics.push(`Notification permission: ${NotificationApi.permission}.`);
    if (NotificationApi.permission !== 'granted') {
      diagnostics.push('No delivery attempted because notification permission is not granted.');
      return {
        status: NotificationApi.permission === 'default' ? 'prompt' : 'denied',
        diagnostics,
      };
    }
  } catch (error) {
    diagnostics.push(`Could not read notification permission: ${errorDetails(error)}`);
    return { status: 'unsupported', diagnostics };
  }

  const registration = await readyNotificationRegistration(diagnostics);
  if (registration) {
    if (serviceWorkerShowFailure) {
      diagnostics.push(`ServiceWorkerRegistration.showNotification() not retried; previously unsupported: ${serviceWorkerShowFailure}`);
    } else if (registration.active && typeof registration.showNotification === 'function') {
      try {
        await registration.showNotification(title, options);
        diagnostics.push('ServiceWorkerRegistration.showNotification(): succeeded.');
        return { status: 'shown', method: 'service-worker', diagnostics };
      } catch (error) {
        const details = errorDetails(error);
        diagnostics.push(`ServiceWorkerRegistration.showNotification(): rejected: ${details}`);
        if (error instanceof DOMException && ['NotAllowedError', 'NotSupportedError'].includes(error.name)) {
          serviceWorkerShowFailure = details;
          diagnostics.push('This service-worker notification failure will not be retried during this app session.');
        }
      }
    } else {
      diagnostics.push(`Service worker cannot display notifications: active worker ${registration.active ? 'present' : 'missing'}, showNotification ${typeof registration.showNotification === 'function' ? 'available' : 'unavailable'}.`);
    }
  }

  if (notificationConstructorFailure) {
    diagnostics.push(`Notification constructor not retried; previously unsupported: ${notificationConstructorFailure}`);
    return { status: 'failed', diagnostics };
  }
  try {
    new NotificationApi(title, options);
    diagnostics.push('Notification constructor: succeeded.');
    return { status: 'shown', method: 'constructor', diagnostics };
  } catch (error) {
    const details = errorDetails(error);
    diagnostics.push(`Notification constructor: rejected: ${details}`);
    if ((error instanceof TypeError && /illegal constructor/i.test(error.message))
      || (error instanceof DOMException && ['NotAllowedError', 'NotSupportedError'].includes(error.name))) {
      notificationConstructorFailure = details;
      notificationConstructorFailureApi = NotificationApi;
      diagnostics.push('This browser does not support constructor delivery; it will not be retried during this app session.');
    }
    return { status: 'failed', diagnostics };
  }
}

export async function sendBrowserTestNotification(): Promise<string> {
  const result = await showBrowserNotification(
    'Quiet Notes test notification',
    { body: 'This confirms this browser displayed a notification.', tag: 'quiet-notes-test' },
  );
  return result.diagnostics.join('\n');
}

async function sendNativeTestNotification(): Promise<string> {
  const permission = await currentReminderPermission();
  if (permission !== 'granted') {
    return permission === 'prompt'
      ? 'Notification permission has not been granted. Enable notifications before sending a test.'
      : permission === 'denied'
        ? 'Notification permission is denied. Enable it in Android settings before sending a test.'
        : 'Native notifications are unavailable on this device.';
  }

  const result = await LocalNotifications.schedule({
    notifications: [{
      id: reminderId('quiet-notes-test', Date.now()),
      title: 'Quiet Notes',
      body: 'This is a test of Android local notifications.',
      schedule: {
        at: new Date(Date.now() + 2_000),
      },
      isExactNotification: false,
      extra: { quietNotesTest: true },
    }],
  });
  if (result.warning?.message) {
    return `The Android test notification was scheduled with a warning: ${result.warning.message}`;
  }
  return 'The Android test notification was scheduled. Android may delay inexact notifications; delivery cannot be confirmed until it appears on this device.';
}

export function sendReminderTestNotification(): Promise<string> {
  return Capacitor.isNativePlatform()
    ? sendNativeTestNotification()
    : sendBrowserTestNotification();
}

function clearBrowserTimers(): void {
  for (const timer of browserTimers.values()) clearTimeout(timer);
  browserTimers.clear();
}

function reportDiagnostic(report: ReminderDiagnostic | undefined, message: string): void {
  if (!report) {
    console.warn(message);
    return;
  }
  try {
    report(message);
  } catch (error) {
    console.error('Could not display a task reminder diagnostic.', error);
  }
}

function hasFired(id: number, report?: ReminderDiagnostic): boolean {
  try {
    const fired: unknown = JSON.parse(localStorage.getItem(FIRED_REMINDERS_KEY) ?? '[]');
    return Array.isArray(fired) && fired.includes(id);
  } catch (error) {
    reportDiagnostic(report, `Reminder history could not be read; a duplicate notification may occur. ${error instanceof Error ? error.message : ''}`.trim());
    return false;
  }
}

function markFired(id: number, report?: ReminderDiagnostic): boolean {
  try {
    const fired: unknown = JSON.parse(localStorage.getItem(FIRED_REMINDERS_KEY) ?? '[]');
    const values = Array.isArray(fired) ? fired.filter(Number.isInteger) as number[] : [];
    localStorage.setItem(FIRED_REMINDERS_KEY, JSON.stringify([...new Set([...values, id])].slice(-500)));
    return true;
  } catch (error) {
    reportDiagnostic(report, `Notification was displayed but reminder history could not be saved; a duplicate notification may occur. ${error instanceof Error ? error.message : ''}`.trim());
    return false;
  }
}

async function fireBrowserReminder(
  reminder: UpcomingReminder,
  report?: ReminderDiagnostic,
): Promise<void> {
  if (hasFired(reminder.id, report)) return;
  const result = await showBrowserNotification(
    reminder.note.title.trim() || 'Quiet task',
    {
      body: 'It is time to revisit this task.',
      tag: `quiet-notes-${reminder.id}`,
    },
  );
  if (result.status === 'shown') {
    if (markFired(reminder.id, report)) {
      reportDiagnostic(report, `Reminder notification displayed for “${reminder.note.title.trim() || 'Quiet task'}”.`);
    }
  } else {
    reportDiagnostic(report, `Could not deliver reminder for “${reminder.note.title.trim() || 'Quiet task'}”. ${result.diagnostics.join(' ')}`);
  }
}

function setBrowserReminder(reminder: UpcomingReminder, report?: ReminderDiagnostic): void {
  const delay = reminder.at - Date.now();
  const timer = setTimeout(() => {
    browserTimers.delete(reminder.id);
    if (reminder.at > Date.now()) {
      setBrowserReminder(reminder, report);
      return;
    }
    void fireBrowserReminder(reminder, report).catch(error => {
      reportDiagnostic(report, `Reminder delivery failed: ${error instanceof Error ? error.message : 'unknown error'}.`);
    });
  }, Math.min(delay, MAX_TIMEOUT));
  browserTimers.set(reminder.id, timer);
}

export async function scheduleTaskReminders(
  notes: QuietNote[],
  report?: ReminderDiagnostic,
): Promise<string> {
  try {
    const reminders = upcomingReminders(notes);
    if (Capacitor.isNativePlatform()) {
      const pending = await LocalNotifications.getPending();
      const managed = pending.notifications.filter(
        notification => notification.extra?.quietNotesReminder === true,
      );
      if (managed.length) {
        await LocalNotifications.cancel({
          notifications: managed.map(({ id }) => ({ id })),
        });
      }
      if (reminders.length === 0) return 'No upcoming task reminders are scheduled. Set a future reminder date and time on a task.';
      const permission = await currentReminderPermission();
      if (permission !== 'granted') return permission === 'unsupported'
        ? 'Native notifications are unsupported or unavailable on this device.'
        : permission === 'prompt'
          ? 'Notification permission has not been granted. Enable notifications to schedule reminders.'
          : 'Notification permission is denied. Enable notifications in device settings.';
      const result = await LocalNotifications.schedule({
        notifications: reminders.map(reminder => ({
          id: reminder.id,
          title: reminder.note.title.trim() || 'Quiet task',
          body: 'It is time to revisit this task.',
          schedule: { at: new Date(reminder.at) },
          isExactNotification: false,
          extra: { quietNotesReminder: true, noteId: reminder.note.id },
        })),
      });
      if (result.warning?.message) return `Reminder scheduling warning: ${result.warning.message}`;
      return `${reminders.length} task reminder${reminders.length === 1 ? '' : 's'} scheduled on this device.`;
    }

    clearBrowserTimers();
    if (reminders.length === 0) return 'No upcoming task reminders are scheduled. Set a future reminder date and time on a task.';
    const permission = await currentReminderPermission();
    if (permission === 'unsupported') return 'This browser does not support notifications.';
    if (permission !== 'granted') return permission === 'prompt'
      ? 'Browser notification permission has not been granted. Select Enable notifications to allow reminders.'
      : 'Browser notification permission is denied. Allow notifications in browser or device settings.';
    const schedulingDiagnostics: string[] = [];
    const reportSchedulingDiagnostic: ReminderDiagnostic = message => {
      schedulingDiagnostics.push(message);
      reportDiagnostic(report, message);
    };
    let scheduled = 0;
    for (const reminder of reminders) {
      if (!hasFired(reminder.id, reportSchedulingDiagnostic)) {
        setBrowserReminder(reminder, report);
        scheduled += 1;
      }
    }
    if (scheduled === 0) return 'No upcoming task reminders are scheduled; all matching reminders were already delivered.';
    const result = `${scheduled} task reminder${scheduled === 1 ? '' : 's'} scheduled. Keep this browser tab open for delivery.`;
    return schedulingDiagnostics.length ? `${schedulingDiagnostics.join(' ')} ${result}` : result;
  } catch (error) {
    const message = `Task reminders could not be scheduled on this device: ${error instanceof Error ? error.message : 'unknown error'}.`;
    reportDiagnostic(report, message);
    return message;
  }
}
