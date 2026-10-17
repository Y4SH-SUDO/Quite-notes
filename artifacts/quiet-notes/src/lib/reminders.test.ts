import assert from 'node:assert/strict';
import test from 'node:test';
import {
  currentReminderPermission,
  reminderId,
  requestReminderPermission,
  scheduleTaskReminders,
  sendBrowserTestNotification,
  showBrowserNotification,
  upcomingReminders,
} from './reminders.ts';
import type { QuietNote } from '../quiet-storage.ts';

const task: QuietNote = {
  id: 'task-with-reminder',
  title: 'Call the dentist',
  kind: 'task',
  content: '',
  createdAt: 1,
  updatedAt: 2,
  recentlyOpenedAt: 3,
  dueDate: '2026-10-20',
  reminderAt: 1_800_000_000_000,
  reminderTimezone: 'America/Los_Angeles',
};

test('reminder IDs are deterministic and change when the scheduled instant changes', () => {
  assert.equal(reminderId(task.id, task.reminderAt!), reminderId(task.id, task.reminderAt!));
  assert.notEqual(reminderId(task.id, task.reminderAt!), reminderId(task.id, task.reminderAt! + 60_000));
  assert.ok(reminderId(task.id, task.reminderAt!) >= 0);
});

test('only future reminders attached to tasks are scheduled', () => {
  const noteWithReminder = { ...task, id: 'note', kind: 'note' as const };
  const expiredTask = { ...task, id: 'expired', reminderAt: 50 };

  assert.deepEqual(
    upcomingReminders([task, noteWithReminder, expiredTask], 100)
      .map(({ note, at }) => ({ id: note.id, at })),
    [{ id: task.id, at: task.reminderAt }],
  );
});

test('browser notification helper safely reports unsupported environments', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Reflect.deleteProperty(globalThis, 'Notification');

  try {
    assert.equal(await currentReminderPermission(), 'unsupported');
    assert.equal((await showBrowserNotification('Task', {})).status, 'unsupported');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
  }
});

test('browser notification helper does not construct notifications when permission is denied', async t => {
  let constructed = false;
  class DeniedNotification {
    static permission: NotificationPermission = 'denied';
    static requestPermission = async () => 'denied' as NotificationPermission;
    constructor() {
      constructed = true;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: DeniedNotification,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
  });

  assert.equal((await showBrowserNotification('Task', {})).status, 'denied');
  assert.equal(constructed, false);
});

test('browser notification constructor failures are contained', async t => {
  class IllegalConstructorNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
    constructor() {
      throw new TypeError("Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.");
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: IllegalConstructorNotification,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
  });

  const result = await showBrowserNotification('Task', {});
  assert.equal(result.status, 'failed');
  assert.ok(result.diagnostics.some(line => line.includes('TypeError: Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.')));
});

test('active service worker receives notifications before the constructor fallback', async t => {
  let constructorCalled = false;
  let serviceWorkerCalled = false;
  class FallbackNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
    constructor() {
      constructorCalled = true;
    }
  }
  const notificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const registration = {
    active: {},
    showNotification: async () => {
      serviceWorkerCalled = true;
    },
  };
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: FallbackNotification,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
      },
    },
  });
  t.after(() => {
    if (notificationDescriptor) Object.defineProperty(globalThis, 'Notification', notificationDescriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  assert.equal((await showBrowserNotification('Task', {})).status, 'shown');
  assert.equal(serviceWorkerCalled, true);
  assert.equal(constructorCalled, false);
});

test('service-worker and constructor exception details are retained', async t => {
  class FailingNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
    constructor() {
      throw new DOMException('constructor blocked by policy', 'NotAllowedError');
    }
  }
  const registration = {
    active: {},
    showNotification: async () => {
      throw new DOMException('service worker rejected notification', 'InvalidStateError');
    },
  };
  const notificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FailingNotification });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: { getRegistration: async () => registration, ready: Promise.resolve(registration) } },
  });
  t.after(() => {
    if (notificationDescriptor) Object.defineProperty(globalThis, 'Notification', notificationDescriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  const result = await showBrowserNotification('Task', {});
  assert.equal(result.status, 'failed');
  assert.ok(result.diagnostics.some(line => line.includes('InvalidStateError: service worker rejected notification')));
  assert.ok(result.diagnostics.some(line => line.includes('NotAllowedError: constructor blocked by policy')));
});

test('test notification displays environment, registration readiness, and actual delivery result', async t => {
  let displayed = 0;
  class TestNotification {
    static permission: NotificationPermission = 'granted';
  }
  const registration = {
    active: { state: 'activated' },
    showNotification: async () => { displayed += 1; },
  };
  const notificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: TestNotification });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: { getRegistration: async () => registration, ready: Promise.resolve(registration) } },
  });
  t.after(() => {
    if (notificationDescriptor) Object.defineProperty(globalThis, 'Notification', notificationDescriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  const output = await sendBrowserTestNotification();
  assert.match(output, /Origin:/);
  assert.match(output, /Secure context:/);
  assert.match(output, /Notification permission: granted/);
  assert.match(output, /Service worker readiness: ready/);
  assert.match(output, /showNotification\(\): succeeded/);
  assert.equal(displayed, 1);
});

test('test notification registers and waits for a worker when none exists', async t => {
  let registered = '';
  const registration = {
    active: { state: 'activated' },
    showNotification: async () => {},
  };
  class TestNotification {
    static permission: NotificationPermission = 'granted';
  }
  const notificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: TestNotification });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      serviceWorker: {
        getRegistration: async () => undefined,
        register: async (url: string) => {
          registered = url;
          return registration;
        },
        ready: Promise.resolve(registration),
      },
    },
  });
  t.after(() => {
    if (notificationDescriptor) Object.defineProperty(globalThis, 'Notification', notificationDescriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  const output = await sendBrowserTestNotification();
  assert.match(registered, /quiet-notes-sw\.js$/);
  assert.match(output, /no registration found/);
  assert.match(output, /Service worker readiness: ready/);
  assert.match(output, /showNotification\(\): succeeded/);
});

test('requesting browser notification permission calls the browser permission API', async t => {
  let requests = 0;
  class PermissionNotification {
    static permission: NotificationPermission = 'default';
    static requestPermission = async () => {
      requests += 1;
      return 'granted' as NotificationPermission;
    };
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: PermissionNotification });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
  });

  assert.equal(await requestReminderPermission(), 'granted');
  assert.equal(requests, 1);
});

test('browser default permission is reported as prompt rather than denied', async t => {
  class UnrequestedNotification {
    static permission: NotificationPermission = 'default';
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: UnrequestedNotification });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
  });

  assert.equal(await currentReminderPermission(), 'prompt');
});

test('browser scheduler fires a future reminder and reports delivery while the tab is open', async t => {
  let notificationCount = 0;
  const values = new Map<string, string>();
  const diagnostics: string[] = [];
  class TestNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
    constructor() {
      notificationCount += 1;
    }
  }
  const notificationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: TestNotification });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    },
  });
  t.after(() => {
    if (notificationDescriptor) Object.defineProperty(globalThis, 'Notification', notificationDescriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });

  const reminder = { ...task, reminderAt: Date.now() + 80 };
  const result = await scheduleTaskReminders([reminder], message => diagnostics.push(message));
  assert.match(result, /1 task reminder scheduled/);
  assert.match(result, /Keep this browser tab open/);
  await new Promise(resolve => setTimeout(resolve, 150));

  assert.equal(notificationCount, 1);
  assert.ok(diagnostics.some(message => message.includes('Reminder notification displayed')));
});

test('browser scheduler reports when no future reminder is set', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Notification');
  class GrantedNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
  }
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: GrantedNotification });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'Notification', descriptor);
    else Reflect.deleteProperty(globalThis, 'Notification');
  });

  assert.match(await scheduleTaskReminders([{ ...task, reminderAt: Date.now() - 1 }]), /No upcoming task reminders/);
});
