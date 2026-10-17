import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowUp, Bell, Bold, Check,
  Clock3, Download, FileText, ImagePlus, Italic, Library, ListChecks, ListTodo,
  MoreHorizontal, Plus, Search, Settings, Trash2, Underline,
  Upload, X,
} from 'lucide-react';
import {
  defaultSettings, newNote, quietStorage,
  type BackupImportResult, type NoteKind, type QuietNote, type QuietSettings,
} from './quiet-storage';
import {
  runBackupWorker,
  type ImportStrategy, type QuietNotesBackup,
} from './lib/backup';
import {
  currentReminderPermission, requestReminderPermission, scheduleTaskReminders,
  sendBrowserTestNotification,
  type ReminderPermission,
} from './lib/reminders';
import { updateTaskSchedule as mergeTaskSchedule } from './lib/task-schedule';
import type { User } from 'firebase/auth';
import { isFirebaseConfigured } from './lib/firebase-config';
import type { ImageSyncFailure, NoteSyncConflict } from './lib/cloud-sync';
import {
  createChecklistItem, createImageFigure, defaultImageOptions, insertImageFigure,
  migrateLegacyChecklistItems, migrateLegacyImages, placeCaretAtStart,
  type ImageOptions, type ImageSize,
} from './lib/editor-dom';

const queryClient = new QueryClient();
const cloudSyncTimeoutMs = 60_000;
const kindNames: Record<NoteKind, string> = {
  note: 'Note',
  task: 'Task',
  journal: 'Journal',
  checklist: 'Checklist',
};

type BackupPreview = {
  backup: QuietNotesBackup;
  duplicateIds: string[];
  imageCount: number;
};

type BackupStatus = {
  kind: 'success' | 'error' | 'info';
  text: string;
};

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function localDateTimeInput(timestamp?: number) {
  if (timestamp === undefined) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function notePreview(note: QuietNote) {
  const text = new DOMParser().parseFromString(note.content, 'text/html').body.textContent?.trim() ?? '';
  return text || (note.kind === 'checklist' ? 'A list, waiting to be made.' : 'An open page.');
}

function noteTags(note: QuietNote) {
  const source = `${note.title} ${notePreview(note)}`;
  return Array.from(new Set(Array.from(source.matchAll(/#([\w-]+)/g), match => match[1].toLowerCase())));
}

function checklistProgress(note: QuietNote) {
  const document = new DOMParser().parseFromString(note.content, 'text/html');
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-check-item]'));
  const completed = items.filter(item => item.querySelector<HTMLInputElement>('input[type="checkbox"]')?.hasAttribute('checked')).length;
  return { completed, total: items.length, isComplete: items.length > 0 && completed === items.length };
}

function cloudSyncErrorMessage(error: unknown): string {
  const errorDetails = typeof error === 'object' && error !== null ? error : {};
  const stage = 'stage' in errorDetails && typeof errorDetails.stage === 'string'
    ? errorDetails.stage
    : 'starting sync';
  const rawCode = 'code' in errorDetails && typeof errorDetails.code === 'string'
    ? errorDetails.code
    : '';
  const code = /^[a-z-]+(?:\/[a-z-]+)?$/.test(rawCode) ? rawCode : 'unknown';
  let action = 'Check this device’s connection, the Firebase project configuration, and the rules for the service named above.';
  if (code === 'not-found' || code === 'firestore/not-found') {
    action = 'Create the project’s Cloud Firestore database in Firebase Console, then publish the checked-in Firestore rules.';
  } else if (code.endsWith('permission-denied') || code === 'storage/unauthorized') {
    action = 'Check that the published Firestore and Storage rules allow this signed-in account at the reported stage.';
  } else if (code === 'unauthenticated' || code === 'firestore/unauthenticated') {
    action = 'Sign in again, then retry.';
  } else if (code === 'unavailable' || code === 'deadline-exceeded' || code === 'network-request-failed') {
    action = 'Check this device’s connection and that Firebase endpoints are reachable, then retry.';
  }
  return `Cloud sync failed during ${stage} (${code}). ${action} Your local notes remain saved on this device.`;
}

function imageSyncWarning(failures: ImageSyncFailure[]): string {
  if (failures.length === 0) return '';
  const images = failures
    .map(failure => `“${failure.noteTitle || failure.noteId}” (image ${failure.imageNumber})`)
    .join(', ');
  return ` Image sync failed for ${images}. Text and task sync can continue, but these images may be available only on the device where they were originally added until Firebase Storage is configured. Local notes and images were not changed.`;
}

function groupByDate(notes: QuietNote[], dateOf: (note: QuietNote) => number) {
  const groups = new Map<string, QuietNote[]>();
  for (const note of notes) {
    const date = new Date(dateOf(note));
    const key = date.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  return Array.from(groups, ([date, groupedNotes]) => ({ date, notes: groupedNotes }));
}

function serializeEditor(editor: HTMLElement) {
  editor.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(checkbox => {
    checkbox.toggleAttribute('checked', checkbox.checked);
  });
  return editor.innerHTML;
}

function isTextBlock(element: Element | null | undefined): element is HTMLElement {
  return Boolean(element && (element.tagName === 'P' || element.tagName === 'DIV') && !element.hasAttribute('data-check-item'));
}

function AppSurface() {
  const [notes, setNotes] = useState<QuietNote[]>([]);
  const [settings, setSettings] = useState<QuietSettings>(defaultSettings);
  const [screen, setScreen] = useState<'home' | 'library' | 'editor' | 'settings'>('home');
  const [activeNote, setActiveNote] = useState<QuietNote | null>(null);
  const [search, setSearch] = useState('');
  const [librarySearch, setLibrarySearch] = useState('');
  const [libraryKind, setLibraryKind] = useState<'all' | NoteKind>('all');
  const [libraryTag, setLibraryTag] = useState<string | null>(null);
  const [taskFilter, setTaskFilter] = useState<'all' | 'open' | 'complete'>('all');
  const [kindMenu, setKindMenu] = useState(false);
  const [editorSettingsOpen, setEditorSettingsOpen] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveMessage, setSaveMessage] = useState('');
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupPreview, setBackupPreview] = useState<BackupPreview | null>(null);
  const [backupStrategy, setBackupStrategy] = useState<ImportStrategy>('merge');
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [reminderPermission, setReminderPermission] = useState<ReminderPermission>('unsupported');
  const [reminderStatus, setReminderStatus] = useState('');
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState('');
  const [syncConflicts, setSyncConflicts] = useState<NoteSyncConflict[]>([]);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const syncInProgressRef = useRef(false);
  const syncStageRef = useRef('initializing Firebase');

  const refreshNotes = useCallback(async () => {
    try {
      const [storedNotes, storedSettings] = await Promise.all([
        quietStorage.listNotes(), quietStorage.getSettings(),
      ]);
      setNotes(storedNotes.sort((a, b) => b.recentlyOpenedAt - a.recentlyOpenedAt));
      if (storedSettings) setSettings(storedSettings);
      setStoreError('');
      setLoadState('ready');
    } catch (error) {
      setLoadState('error');
      setStoreError(error instanceof Error ? error.message : 'Your local notes could not be opened.');
    }
  }, []);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setAuthLoading(false);
      setSyncStatus('Cloud sync needs Firebase project configuration before you can sign in.');
      return;
    }
    let cancelled = false;
    let unsubscribe = () => {};
    void Promise.all([import('./lib/firebase'), import('firebase/auth')]).then(([firebase, authApi]) => {
      if (cancelled) return;
      unsubscribe = authApi.onAuthStateChanged(firebase.getFirebaseServices().auth, user => {
        setFirebaseUser(user);
        setAuthLoading(false);
        setSyncConflicts([]);
        if (!user) setSyncStatus('Sign in to sync your notes across devices.');
      }, error => {
        setAuthLoading(false);
        setSyncStatus(error.message || 'Firebase sign-in state could not be read.');
      });
    }).catch(error => {
      setAuthLoading(false);
      setSyncStatus(error instanceof Error ? error.message : 'Firebase could not be initialized.');
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const synchronizeNotes = useCallback(async (user = firebaseUser) => {
    if (!user) return;
    if (syncInProgressRef.current) {
      setSyncStatus('A previous sync is still waiting for Firebase. Your local notes are safe. Reload this app to stop waiting, then tap Sync now.');
      return;
    }
    syncInProgressRef.current = true;
    setSyncBusy(true);
    syncStageRef.current = 'initializing Firebase';
    const syncTimeout = window.setTimeout(() => {
      setSyncBusy(false);
      setSyncStatus(`Cloud sync is still waiting during ${syncStageRef.current} (Firebase has not returned an error code). Check that the corresponding Firebase service is configured and reachable. Your local notes remain saved. If it remains stuck, reload the app before retrying.`);
    }, cloudSyncTimeoutMs);
    try {
      syncStageRef.current = 'loading Firebase services';
      const [{ getFirebaseServices }, { syncUserNotes }] = await Promise.all([
        import('./lib/firebase'),
        import('./lib/cloud-sync'),
      ]);
      const { firestore, storage } = getFirebaseServices();
      const result = await syncUserNotes(user.uid, firestore, storage, stage => {
        syncStageRef.current = stage;
      });
      setSyncConflicts(current => {
        const next = new Map(current.map(conflict => [conflict.id, conflict]));
        for (const conflict of result.conflicts) next.set(conflict.id, conflict);
        return Array.from(next.values());
      });
      syncStageRef.current = 'refreshing local notes on this device';
      await refreshNotes();
      const syncSummary =
        result.conflicts.length > 0
          ? `${result.conflicts.length} note conflict${result.conflicts.length === 1 ? '' : 's'} need your review. Neither version was overwritten.`
          : `Synced. ${result.uploaded} uploaded, ${result.downloaded} downloaded, ${result.deleted} deleted.`;
      setSyncStatus(`${syncSummary}${imageSyncWarning(result.imageFailures)}`);
    } catch (error) {
      setSyncStatus(cloudSyncErrorMessage(error));
    } finally {
      window.clearTimeout(syncTimeout);
      syncInProgressRef.current = false;
      syncStageRef.current = 'initializing Firebase';
      setSyncBusy(false);
    }
  }, [firebaseUser, refreshNotes]);

  const notesSyncSignature = useMemo(
    () => notes.map(note => `${note.id}:${note.updatedAt}`).join('|'),
    [notes],
  );

  useEffect(() => {
    if (!firebaseUser || authLoading || !navigator.onLine) return;
    const timeout = window.setTimeout(() => void synchronizeNotes(firebaseUser), 1500);
    return () => window.clearTimeout(timeout);
  }, [authLoading, firebaseUser, notesSyncSignature, synchronizeNotes]);

  useEffect(() => {
    if (!firebaseUser) return;
    const syncWhenAvailable = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void synchronizeNotes(firebaseUser);
    };
    window.addEventListener('online', syncWhenAvailable);
    window.addEventListener('focus', syncWhenAvailable);
    const interval = window.setInterval(syncWhenAvailable, 60_000);
    return () => {
      window.removeEventListener('online', syncWhenAvailable);
      window.removeEventListener('focus', syncWhenAvailable);
      window.clearInterval(interval);
    };
  }, [firebaseUser, synchronizeNotes]);

  const submitCloudAccount = useCallback(async (createAccount: boolean) => {
    if (!isFirebaseConfigured()) {
      setSyncStatus('Cloud sync needs Firebase project configuration before you can sign in.');
      return;
    }
    try {
      const [{ getFirebaseServices }, authApi] = await Promise.all([
        import('./lib/firebase'),
        import('firebase/auth'),
      ]);
      const { auth } = getFirebaseServices();
      if (createAccount) await authApi.createUserWithEmailAndPassword(auth, authEmail.trim(), authPassword);
      else await authApi.signInWithEmailAndPassword(auth, authEmail.trim(), authPassword);
      setAuthPassword('');
      setSyncStatus('Signed in. Preparing to sync your notes…');
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Sign-in failed.');
    }
  }, [authEmail, authPassword]);

  const signOutCloudAccount = useCallback(async () => {
    try {
      const [{ getFirebaseServices }, authApi] = await Promise.all([
        import('./lib/firebase'),
        import('firebase/auth'),
      ]);
      await authApi.signOut(getFirebaseServices().auth);
      setSyncConflicts([]);
      setSyncStatus('Signed out. Your notes remain saved on this device.');
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Sign-out failed.');
    }
  }, []);

  const resolveCloudConflict = useCallback(async (conflict: NoteSyncConflict, choice: 'device' | 'cloud') => {
    if (!firebaseUser) return;
    try {
      const [{ getFirebaseServices }, { resolveNoteConflict }] = await Promise.all([
        import('./lib/firebase'),
        import('./lib/cloud-sync'),
      ]);
      const { firestore, storage } = getFirebaseServices();
      const imageFailures = await resolveNoteConflict(firebaseUser.uid, conflict, choice, firestore, storage);
      setSyncConflicts(current => current.filter(item => item.id !== conflict.id));
      await refreshNotes();
      setSyncStatus(`Conflict resolved using the selected version.${imageSyncWarning(imageFailures)}`);
      void synchronizeNotes(firebaseUser);
    } catch (error) {
      setSyncStatus(error instanceof Error ? error.message : 'Conflict resolution failed. Neither local note was deleted.');
    }
  }, [firebaseUser, refreshNotes, synchronizeNotes]);

  useEffect(() => { void refreshNotes(); }, [refreshNotes]);

  useEffect(() => {
    let mounted = true;
    void currentReminderPermission().then(permission => {
      if (!mounted) return;
      setReminderPermission(permission);
      setReminderStatus(
        permission === 'granted'
          ? 'Notification permission is enabled.'
          : permission === 'prompt'
            ? 'Notification permission has not been requested yet. Use Enable notifications to allow reminders.'
          : permission === 'denied'
            ? 'Notification permission is denied. Allow notifications in browser or device settings.'
            : 'Notifications are unsupported or unavailable in this browser or device.',
      );
    }).catch(error => {
      if (mounted) setReminderStatus(error instanceof Error ? error.message : 'Notification permission could not be checked.');
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (reminderPermission !== 'granted') return;
    void scheduleTaskReminders(notes, message => setReminderStatus(message)).then(message => {
      if (message) setReminderStatus(message);
    }).catch(error => {
      setReminderStatus(error instanceof Error ? error.message : 'Task reminders could not be scheduled.');
    });
  }, [notes, reminderPermission]);

  const enableReminders = useCallback(async () => {
    setReminderStatus('Requesting notification permission…');
    try {
      const permission = await requestReminderPermission();
      setReminderPermission(permission);
      setReminderStatus(
        permission === 'granted'
          ? 'Notifications are enabled. Upcoming task reminders will be scheduled on this device.'
          : permission === 'unsupported'
            ? 'Notifications are not supported by this browser or device.'
            : 'Notification permission was not granted. You can change this in device or browser settings.',
      );
    } catch (error) {
      setReminderStatus(error instanceof Error ? error.message : 'Notification permission could not be requested.');
    }
  }, []);

  const testReminderNotification = useCallback(async () => {
    setReminderStatus('Checking this browser and attempting one test notification…');
    try {
      const diagnostic = await sendBrowserTestNotification();
      setReminderStatus(`Test notification diagnostic:\n${diagnostic}`);
    } catch (error) {
      setReminderStatus(`Test notification diagnostic failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
  }, []);

  const updateNoteMemory = useCallback((updated: QuietNote) => {
    setNotes(current => [updated, ...current.filter(item => item.id !== updated.id)]
      .sort((a, b) => b.recentlyOpenedAt - a.recentlyOpenedAt));
    setActiveNote(updated);
  }, []);

  const openNote = useCallback(async (note: QuietNote) => {
    const opened = { ...note, recentlyOpenedAt: Date.now() };
    setEditorSettingsOpen(false);
    updateNoteMemory(opened);
    setScreen('editor');
    setSaveState('saving');
    try {
      await quietStorage.saveNote(opened);
      setSaveState('saved');
      setStoreError('');
    } catch (error) {
      setSaveState('error');
      setStoreError(error instanceof Error ? error.message : 'This note could not be saved.');
    }
  }, [updateNoteMemory]);

  const createNote = useCallback(async (kind: NoteKind) => {
    const created = newNote(kind);
    setEditorSettingsOpen(false);
    updateNoteMemory(created);
    setScreen('editor');
    setKindMenu(false);
    setSaveState('saving');
    try {
      await quietStorage.saveNote(created);
      setSaveState('saved');
      setStoreError('');
    } catch (error) {
      setSaveState('error');
      setStoreError(error instanceof Error ? error.message : 'This note could not be saved.');
    }
  }, [updateNoteMemory]);

  const persistNote = useCallback(async (updated: QuietNote) => {
    updateNoteMemory(updated);
    setSaveState('saving');
    try {
      await quietStorage.saveNote(updated);
      setSaveState('saved');
      setStoreError('');
    } catch (error) {
      setSaveState('error');
      setStoreError(error instanceof Error ? error.message : 'Your edits could not be saved.');
    }
  }, [updateNoteMemory]);

  const deleteNote = useCallback(async (note: QuietNote) => {
    if (!window.confirm('Delete this page from this device? This cannot be undone.')) return;
    try {
      if (firebaseUser) await quietStorage.markNoteDeletedForSync(firebaseUser.uid, note.id);
      await quietStorage.deleteNote(note.id);
      setNotes(current => current.filter(item => item.id !== note.id));
      if (activeNote?.id === note.id) {
        setActiveNote(null);
        setScreen('home');
      }
      setStoreError('');
    } catch (error) {
      setStoreError(error instanceof Error ? error.message : 'This note could not be deleted.');
    }
  }, [activeNote, firebaseUser]);

  const savePreferences = useCallback(async (next: QuietSettings) => {
    setSettings(next);
    try {
      await quietStorage.saveSettings(next);
      setStoreError('');
    } catch (error) {
      setStoreError(error instanceof Error ? error.message : 'Your preferences could not be saved.');
    }
  }, []);

  const exportBackup = useCallback(async () => {
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const [storedNotes, storedSettings] = await Promise.all([
        quietStorage.listNotes(),
        quietStorage.getSettings(),
      ]);
      const response = await runBackupWorker({
        action: 'serialize',
        notes: storedNotes,
        settings: storedSettings ?? defaultSettings,
      });
      if (!response.ok) throw new Error(response.error);
      if (typeof response.value !== 'string') throw new Error('The backup could not be prepared for download.');

      const blob = new Blob([response.value], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `quiet-notes-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupStatus({ kind: 'success', text: `Backup exported with ${storedNotes.length} ${storedNotes.length === 1 ? 'note' : 'notes'}.` });
    } catch (error) {
      setBackupStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'The backup could not be exported.',
      });
    } finally {
      setBackupBusy(false);
    }
  }, []);

  const previewBackupFile = useCallback(async (file?: File) => {
    if (!file) return;
    setBackupBusy(true);
    setBackupPreview(null);
    setBackupStatus({ kind: 'info', text: 'Reading and validating backup…' });
    try {
      const response = await runBackupWorker({ action: 'parse', text: await file.text() });
      if (!response.ok) throw new Error(response.error);
      if (typeof response.value === 'string') throw new Error('The selected file is not a valid backup.');

      const existingNotes = await quietStorage.listNotes();
      const existingIds = new Set(existingNotes.map(note => note.id));
      const backup = response.value;
      setBackupPreview({
        backup,
        duplicateIds: backup.notes.filter(note => existingIds.has(note.id)).map(note => note.id),
        imageCount: response.imageCount ?? 0,
      });
      setBackupStrategy('merge');
      setBackupStatus(null);
    } catch (error) {
      setBackupStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'The selected backup could not be read.',
      });
    } finally {
      setBackupBusy(false);
    }
  }, []);

  const confirmBackupImport = useCallback(async () => {
    if (!backupPreview) return;
    setBackupBusy(true);
    setBackupStatus(null);
    try {
      const result: BackupImportResult = await quietStorage.importBackup(
        backupPreview.backup.notes,
        backupPreview.backup.settings,
        backupStrategy,
      );
      setBackupPreview(null);
      await refreshNotes();
      if (backupStrategy === 'skip-backup-on-conflict' && result.duplicateIds.length > 0) {
        setBackupStatus({
          kind: 'info',
          text: `Nothing was imported because ${result.duplicateIds.length} duplicate ${result.duplicateIds.length === 1 ? 'ID was' : 'IDs were'} found. Existing notes and preferences were left unchanged.`,
        });
      } else {
        setBackupStatus({
          kind: 'success',
          text: `Imported ${result.importedCount} ${result.importedCount === 1 ? 'note' : 'notes'}${result.skippedCount ? `; kept ${result.skippedCount} existing ${result.skippedCount === 1 ? 'note' : 'notes'} unchanged` : ''}. Writing preferences restored.`,
        });
      }
    } catch (error) {
      setBackupStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'The backup could not be imported. Existing notes were not replaced.',
      });
    } finally {
      setBackupBusy(false);
    }
  }, [backupPreview, backupStrategy, refreshNotes]);

  const filteredNotes = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return notes;
    return notes.filter(note => `${note.title} ${notePreview(note)} ${kindNames[note.kind]}`.toLowerCase().includes(query));
  }, [notes, search]);

  return (
    <main className="quiet-shell quiet-grain">
      {storeError && (
        <div className="fixed top-0 z-30 flex w-full items-center justify-between gap-4 border-b border-[#5a342c] bg-[#21110e] px-5 py-3 text-sm text-[#e7c5b8]" data-testid="status-storage-error">
          <span>{storeError} Your latest edits remain open here; retry the save before leaving.</span>
          <button className="control-focus rounded px-2 py-1 text-xs underline underline-offset-4" onClick={() => screen === 'settings' ? void savePreferences(settings) : screen === 'editor' && activeNote ? void persistNote(activeNote) : void refreshNotes()} data-testid="button-retry-storage">Retry</button>
        </div>
      )}

      {screen === 'home' && (
        <HomeScreen
          notes={filteredNotes}
          totalNotes={notes.length}
          search={search}
          setSearch={setSearch}
          loading={loadState === 'loading'}
          loadError={loadState === 'error'}
          onRetry={() => void refreshNotes()}
          onCreate={() => setKindMenu(value => !value)}
          onLibrary={() => { setKindMenu(false); setScreen('library'); }}
          onOpen={note => void openNote(note)}
          onDelete={note => void deleteNote(note)}
          kindMenu={kindMenu}
          onPickKind={kind => void createNote(kind)}
          onSettings={() => { setKindMenu(false); setScreen('settings'); }}
        />
      )}

      {screen === 'library' && (
        <LibraryScreen
          notes={notes}
          loading={loadState === 'loading'}
          loadError={loadState === 'error'}
          search={librarySearch}
          onSearch={setLibrarySearch}
          kind={libraryKind}
          onKindChange={kind => { setLibraryKind(kind); setLibraryTag(null); setTaskFilter('all'); }}
          tag={libraryTag}
          onTagChange={setLibraryTag}
          taskFilter={taskFilter}
          onTaskFilterChange={setTaskFilter}
          onRetry={() => void refreshNotes()}
          onBack={() => setScreen('home')}
          onOpen={note => void openNote(note)}
          onDelete={note => void deleteNote(note)}
        />
      )}

      {screen === 'editor' && activeNote && (
        <NoteEditor
          key={activeNote.id}
          note={activeNote}
          settings={settings}
          saveState={saveState}
          saveMessage={saveMessage}
          onSave={updated => void persistNote(updated)}
          onBack={() => { setEditorSettingsOpen(false); setScreen('home'); setKindMenu(false); }}
          onDelete={() => void deleteNote(activeNote)}
          onSaveMessage={setSaveMessage}
          onSettings={() => setEditorSettingsOpen(true)}
        />
      )}

      {screen === 'editor' && editorSettingsOpen && (
        <div className="fixed inset-0 z-40 flex items-end justify-end bg-black/45 backdrop-blur-[1px] sm:items-stretch" data-testid="panel-editor-settings">
          <div className="h-[68dvh] w-full max-w-[560px] overflow-y-auto rounded-t-2xl border border-[#292723] bg-black shadow-2xl sm:h-full sm:rounded-none sm:border-y-0 sm:border-r-0 sm:border-l">
            <SettingsScreen
              settings={settings}
              onChange={value => void savePreferences(value)}
              onBack={() => setEditorSettingsOpen(false)}
            />
          </div>
        </div>
      )}

      {screen === 'settings' && (
        <SettingsScreen
          settings={settings}
          onChange={value => void savePreferences(value)}
          onBack={() => setScreen('home')}
          reminders={{
            permission: reminderPermission,
            status: reminderStatus,
            onEnable: () => void enableReminders(),
            onTest: () => void testReminderNotification(),
          }}
          cloudSync={{
            configured: isFirebaseConfigured(),
            user: firebaseUser,
            loading: authLoading,
            busy: syncBusy,
            status: syncStatus,
            email: authEmail,
            password: authPassword,
            onEmailChange: setAuthEmail,
            onPasswordChange: setAuthPassword,
            onSignIn: () => void submitCloudAccount(false),
            onCreateAccount: () => void submitCloudAccount(true),
            onSignOut: () => void signOutCloudAccount(),
            onSync: () => void synchronizeNotes(),
            conflicts: syncConflicts,
            onResolve: (conflict, choice) => void resolveCloudConflict(conflict, choice),
          }}
          dataBackup={{
            busy: backupBusy,
            preview: backupPreview,
            strategy: backupStrategy,
            status: backupStatus,
            onExport: () => void exportBackup(),
            onSelectFile: file => void previewBackupFile(file),
            onStrategyChange: setBackupStrategy,
            onImport: () => void confirmBackupImport(),
            onCancelImport: () => { setBackupPreview(null); setBackupStatus(null); },
          }}
        />
      )}
    </main>
  );
}

function HomeScreen(props: {
  notes: QuietNote[];
  totalNotes: number;
  search: string;
  setSearch: (value: string) => void;
  loading: boolean;
  loadError: boolean;
  onRetry: () => void;
  onCreate: () => void;
  onLibrary: () => void;
  onOpen: (note: QuietNote) => void;
  onDelete: (note: QuietNote) => void;
  kindMenu: boolean;
  onPickKind: (kind: NoteKind) => void;
  onSettings: () => void;
}) {
  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-[850px] px-6 pb-24 pt-[max(8vh,48px)] sm:px-10">
      <header className="mb-16 flex items-center justify-between">
        <p className="m-0 text-[11px] uppercase tracking-[.2em] text-[#66615a]" data-testid="text-page-date">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        <button onClick={props.onSettings} className="control-focus grid h-10 w-10 place-items-center rounded-full text-[#827f79] transition hover:bg-[#151412] hover:text-[#ded5c4]" aria-label="Settings" data-testid="button-open-settings">
          <Settings size={18} strokeWidth={1.55} />
        </button>
      </header>

      <div className="mb-14">
        <div className="mb-7 flex items-end justify-between gap-4">
          <div>
            <h1 className="m-0 font-serif text-[clamp(2rem,5vw,3.15rem)] font-normal leading-tight tracking-[-.035em] text-[#ded8cd]">A little room to think.</h1>
            <p className="mb-0 mt-3 font-serif text-base text-[#69655f]">Come back to what matters.</p>
          </div>
          <div className="relative flex shrink-0 items-center gap-2">
            <button onClick={props.onLibrary} aria-label="Library" className="control-focus grid h-11 w-11 place-items-center rounded-full border border-[#302e29] text-[#aaa398] transition hover:bg-[#151412] hover:text-[#ded5c4]" data-testid="button-open-library">
              <Library size={18} strokeWidth={1.55} />
            </button>
            <button onClick={props.onCreate} aria-label="Create a page" className="control-focus grid h-[50px] w-[50px] place-items-center rounded-full border border-[#4a443a] bg-[#c9b999] text-[#171511] transition hover:bg-[#ddcdb0]" data-testid="button-open-create-menu">
              {props.kindMenu ? <X size={19} /> : <Plus size={22} strokeWidth={1.7} />}
            </button>
            {props.kindMenu && (
              <div className="absolute right-0 top-[60px] z-10 w-48 overflow-hidden rounded-xl border border-[#2c2a26] bg-[#11110f] p-1.5 shadow-2xl soft-in" data-testid="menu-create-types">
                {(['note', 'task', 'journal', 'checklist'] as NoteKind[]).map(kind => (
                  <button key={kind} onClick={() => props.onPickKind(kind)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm text-[#d8d2c7] transition hover:bg-[#211f1a]" data-testid={`button-create-${kind}`}>
                    {kind === 'checklist' ? <ListChecks size={16} /> : kind === 'task' ? <ListTodo size={16} /> : <FileText size={16} />}
                    {kindNames[kind]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {props.totalNotes > 0 && (
        <div className="mb-8 max-w-[380px]">
          <label className="flex items-center gap-3 border-b border-[#292723] py-2.5 text-[#77736c] focus-within:border-[#766953]">
            <Search size={16} strokeWidth={1.6} />
            <input
              value={props.search}
              onChange={event => props.setSearch(event.target.value)}
              placeholder="Find a page"
              aria-label="Search notes"
              className="w-full bg-transparent py-1 text-sm text-[#d6d0c5] outline-none placeholder:text-[#5b5852]"
              data-testid="input-search-notes"
            />
            {props.search && <button onClick={() => props.setSearch('')} className="text-[#75716a]" aria-label="Clear search" data-testid="button-clear-search"><X size={15} /></button>}
          </label>
        </div>
      )}

      <div className="flex items-center gap-2 pb-4 text-[10px] font-medium uppercase tracking-[.2em] text-[#595650]">
        <Clock3 size={13} strokeWidth={1.6} />
        <span>{props.search ? 'Search results' : 'Recently opened'}</span>
      </div>
      <div className="divide-y divide-[#191816]">
        {props.loading && [0, 1, 2].map(item => <div key={item} className="animate-pulse py-5" data-testid={`skeleton-note-${item}`}><div className="mb-3 h-4 w-40 rounded bg-[#151412]" /><div className="h-3 w-3/4 rounded bg-[#10100f]" /></div>)}
        {!props.loading && props.loadError && (
          <div className="py-10 text-sm text-[#8f8880]" data-testid="status-load-error">Your pages are still on this device, but could not be read right now.
            <button onClick={props.onRetry} className="ml-3 underline underline-offset-4" data-testid="button-retry-load">Try again</button>
          </div>
        )}
        {!props.loading && !props.loadError && props.notes.map(note => (
          <article key={note.id} className="group relative flex items-start gap-3 py-5" data-testid={`card-note-${note.id}`}>
            <button onClick={() => props.onOpen(note)} className="control-focus min-w-0 flex-1 text-left" data-testid={`button-open-note-${note.id}`}>
              <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h2 className="m-0 truncate font-serif text-[19px] font-normal text-[#d6d0c5] group-hover:text-[#eee7dc]">{note.title.trim() || kindNames[note.kind]}</h2>
                <span className="shrink-0 text-[11px] text-[#5f5c56]" data-testid={`text-updated-${note.id}`}>{formatDate(note.updatedAt)}</span>
              </div>
              <p className="m-0 truncate font-serif text-sm leading-relaxed text-[#74706a]" data-testid={`text-preview-${note.id}`}>{notePreview(note)}</p>
            </button>
            <button onClick={() => props.onDelete(note)} className="control-focus mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[#57544e] opacity-0 transition hover:bg-[#211a18] hover:text-[#c38f7e] focus:opacity-100 group-hover:opacity-100" aria-label={`Delete ${note.title || kindNames[note.kind]}`} data-testid={`button-delete-note-${note.id}`}>
              <Trash2 size={15} strokeWidth={1.6} />
            </button>
          </article>
        ))}
        {!props.loading && !props.loadError && props.notes.length === 0 && (
          <div className="py-12" data-testid="empty-notes">
            <p className="m-0 font-serif text-xl text-[#777168]">{props.search ? 'Nothing found.' : 'The page is yours.'}</p>
            <p className="mb-0 mt-2 max-w-sm font-serif text-sm leading-relaxed text-[#514e48]">{props.search ? 'Try another word, or clear your search.' : 'Start anywhere. A thought, a list, a day worth keeping.'}</p>
          </div>
        )}
      </div>
      {props.totalNotes > 0 && <p className="mt-9 text-[11px] tracking-wide text-[#484640]" data-testid="text-note-count">{props.totalNotes} {props.totalNotes === 1 ? 'page' : 'pages'} kept here</p>}
    </section>
  );
}

function LibraryScreen(props: {
  notes: QuietNote[];
  loading: boolean;
  loadError: boolean;
  search: string;
  onSearch: (value: string) => void;
  kind: 'all' | NoteKind;
  onKindChange: (kind: 'all' | NoteKind) => void;
  tag: string | null;
  onTagChange: (tag: string | null) => void;
  taskFilter: 'all' | 'open' | 'complete';
  onTaskFilterChange: (filter: 'all' | 'open' | 'complete') => void;
  onRetry: () => void;
  onBack: () => void;
  onOpen: (note: QuietNote) => void;
  onDelete: (note: QuietNote) => void;
}) {
  const query = props.search.trim().toLowerCase();
  const matchedNotes = props.notes.filter(note => {
    const matchesKind = props.kind === 'all' || note.kind === props.kind;
    const matchesQuery = !query || `${note.title} ${notePreview(note)} ${kindNames[note.kind]}`.toLowerCase().includes(query);
    return matchesKind && matchesQuery;
  });
  const notes = matchedNotes.filter(note => note.kind === 'note');
  const journals = matchedNotes.filter(note => note.kind === 'journal');
  const tasks = matchedNotes.filter(note => note.kind === 'task');
  const checklists = matchedNotes.filter(note => note.kind === 'checklist');
  const availableTags = Array.from(new Set(notes.flatMap(note => noteTags(note)))).sort();
  const filteredNotes = props.tag
    ? notes.filter(note => noteTags(note).includes(props.tag!))
    : notes;
  const filteredJournals = props.tag
    ? journals.filter(note => noteTags(note).includes(props.tag!))
    : journals;
  const filteredTasks = tasks.filter(note => {
    const complete = checklistProgress(note).isComplete;
    return props.taskFilter === 'all' || (props.taskFilter === 'complete' ? complete : !complete);
  });
  const showNotes = props.kind === 'all' || props.kind === 'note';
  const showJournals = props.kind === 'all' || props.kind === 'journal';
  const showTasks = props.kind === 'all' || props.kind === 'task';
  const showChecklists = props.kind === 'all' || props.kind === 'checklist';
  const hasLibraryResults = filteredNotes.length + filteredJournals.length + filteredTasks.length + checklists.length > 0;

  const renderNote = (note: QuietNote, detail?: ReactNode) => (
    <article key={note.id} className="group flex min-w-0 items-start gap-3 border-b border-[#191816] py-4" data-testid={`library-item-${note.id}`}>
      <button onClick={() => props.onOpen(note)} className="control-focus min-w-0 flex-1 text-left" data-testid={`button-library-open-${note.id}`}>
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="m-0 min-w-0 truncate font-serif text-lg font-normal text-[#d6d0c5] group-hover:text-[#eee7dc]">{note.title.trim() || kindNames[note.kind]}</h3>
          <span className="shrink-0 text-[11px] text-[#5f5c56]">{formatDate(note.updatedAt)}</span>
        </div>
        <p className="mb-0 mt-1 truncate font-serif text-sm leading-relaxed text-[#74706a]">{notePreview(note)}</p>
        {detail && <div className="mt-2">{detail}</div>}
      </button>
      <button onClick={() => props.onDelete(note)} className="control-focus grid h-10 w-10 shrink-0 place-items-center rounded-full text-[#777168] transition hover:bg-[#211a18] hover:text-[#c38f7e]" aria-label={`Delete ${note.title || kindNames[note.kind]}`} data-testid={`button-library-delete-${note.id}`}>
        <Trash2 size={15} strokeWidth={1.6} />
      </button>
    </article>
  );

  const renderTaggedNotes = (items: QuietNote[], includeNotebookTags: boolean) => {
    const groups = new Map<string, QuietNote[]>();
    for (const note of items) {
      const tags = noteTags(note);
      const labels = includeNotebookTags ? (tags.length ? tags : ['journal entries']) : (tags.length ? tags : ['untagged']);
      for (const label of labels) groups.set(label, [...(groups.get(label) ?? []), note]);
    }
    const ordered = Array.from(groups).sort(([left], [right]) => left.localeCompare(right));
    return ordered.map(([label, groupedNotes]) => (
      <section key={label} className="mb-8" data-testid={`library-group-${label.replace(/\s+/g, '-')}`}>
        <h3 className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[.2em] text-[#777168]">
          <span>{includeNotebookTags ? 'Notebook' : 'Tag'}</span><span className="text-[#393732]">·</span><span>{label}</span>
        </h3>
        {includeNotebookTags
          ? groupByDate(groupedNotes, note => note.createdAt).map(group => (
            <div key={group.date} className="mb-3">
              <p className="mb-1 mt-3 text-[10px] uppercase tracking-[.14em] text-[#514e48]">{group.date}</p>
              {group.notes.map(note => renderNote(note))}
            </div>
          ))
          : groupedNotes.map(note => renderNote(note))}
      </section>
    ));
  };

  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-[850px] px-5 pb-24 pt-5 sm:px-10 sm:pt-8" data-testid="screen-library">
      <header className="flex items-center justify-between">
        <button onClick={props.onBack} className="control-focus flex min-h-10 items-center gap-2 rounded-full px-2 text-sm text-[#89847b] transition hover:text-[#e4dccf]" data-testid="button-library-back">
          <ArrowLeft size={17} strokeWidth={1.6} /><span>Home</span>
        </button>
        <p className="m-0 text-[10px] uppercase tracking-[.2em] text-[#66615a]">{props.notes.length} {props.notes.length === 1 ? 'page' : 'pages'}</p>
      </header>

      <div className="mb-8 mt-10">
        <h1 className="m-0 font-serif text-4xl font-normal tracking-[-.035em] text-[#ded8cd]">Library</h1>
        <p className="mb-0 mt-2 max-w-xl font-serif text-sm leading-relaxed text-[#69655f]">Search pages and browse by kind. Use #tags in a title or page to group notes and journals into notebooks.</p>
      </div>

      <label className="mb-5 flex items-center gap-3 border-b border-[#292723] py-2.5 text-[#77736c] focus-within:border-[#766953]">
        <Search size={16} strokeWidth={1.6} />
        <input
          value={props.search}
          onChange={event => props.onSearch(event.target.value)}
          placeholder="Search titles and pages"
          aria-label="Search library"
          className="w-full bg-transparent py-1 text-sm text-[#d6d0c5] outline-none placeholder:text-[#5b5852]"
          data-testid="input-search-library"
        />
        {props.search && <button onClick={() => props.onSearch('')} className="grid h-9 w-9 shrink-0 place-items-center text-[#75716a]" aria-label="Clear library search" data-testid="button-clear-library-search"><X size={15} /></button>}
      </label>

      <nav className="-mx-1 mb-6 flex gap-1 overflow-x-auto pb-2" aria-label="Library categories" data-testid="library-categories">
        {(['all', 'note', 'journal', 'task', 'checklist'] as const).map(kind => (
          <button key={kind} onClick={() => props.onKindChange(kind)} className={`control-focus min-h-10 shrink-0 rounded-full border px-4 text-sm transition ${props.kind === kind ? 'border-[#81745c] bg-[#191711] text-[#dfd2ba]' : 'border-[#302e29] text-[#77736c] hover:border-[#625b4c]'}`} aria-pressed={props.kind === kind} data-testid={`button-library-kind-${kind}`}>
            {kind === 'all' ? 'All' : `${kindNames[kind]}s`}
          </button>
        ))}
      </nav>

      {!props.loading && props.loadError && (
        <div className="py-10 text-sm text-[#8f8880]" data-testid="status-library-load-error">
          Your pages are still on this device, but could not be read right now.
          <button onClick={props.onRetry} className="ml-3 underline underline-offset-4" data-testid="button-library-retry-load">Try again</button>
        </div>
      )}
      {props.loading && <div className="animate-pulse py-10 text-sm text-[#5f5c56]" data-testid="library-loading">Opening your pages…</div>}
      {!props.loading && !props.loadError && (
        <>
          {props.kind === 'all' && !hasLibraryResults && <LibraryEmpty message={props.search ? 'No pages match this search.' : 'Nothing saved here yet.'} />}
          {showNotes && (props.kind !== 'all' || filteredNotes.length > 0) && <>
            {props.kind === 'all' && <h2 className="mb-4 mt-8 text-[10px] font-medium uppercase tracking-[.2em] text-[#595650]">Notes</h2>}
            {availableTags.length > 0 && (
              <div className="mb-5 flex flex-wrap gap-2" aria-label="Filter notes by tag" data-testid="library-note-tags">
                <button onClick={() => props.onTagChange(null)} className={`control-focus min-h-9 rounded-full border px-3 text-xs ${!props.tag ? 'border-[#81745c] text-[#dfd2ba]' : 'border-[#302e29] text-[#77736c]'}`} aria-pressed={!props.tag}>All tags</button>
                {availableTags.map(tag => <button key={tag} onClick={() => props.onTagChange(props.tag === tag ? null : tag)} className={`control-focus min-h-9 rounded-full border px-3 text-xs ${props.tag === tag ? 'border-[#81745c] text-[#dfd2ba]' : 'border-[#302e29] text-[#77736c]'}`} aria-pressed={props.tag === tag} data-testid={`button-library-tag-${tag}`}>#{tag}</button>)}
              </div>
            )}
            {filteredNotes.length ? renderTaggedNotes(filteredNotes, false) : <LibraryEmpty message={props.search ? 'No matching notes.' : 'No notes here yet.'} />}
          </>}

          {showJournals && (props.kind !== 'all' || filteredJournals.length > 0) && <>
            {props.kind === 'all' && <h2 className="mb-4 mt-8 text-[10px] font-medium uppercase tracking-[.2em] text-[#595650]">Journals</h2>}
            {filteredJournals.length ? renderTaggedNotes(filteredJournals, true) : <LibraryEmpty message={props.search ? 'No matching journal entries.' : 'No journal entries yet.'} />}
          </>}

          {showTasks && (props.kind !== 'all' || filteredTasks.length > 0) && <>
            {props.kind === 'all' && <h2 className="mb-4 mt-8 text-[10px] font-medium uppercase tracking-[.2em] text-[#595650]">Tasks</h2>}
            <div className="mb-4 flex gap-2" role="group" aria-label="Task completion filter">
              {(['all', 'open', 'complete'] as const).map(filter => <button key={filter} onClick={() => props.onTaskFilterChange(filter)} className={`control-focus min-h-9 rounded-full border px-3 text-xs capitalize ${props.taskFilter === filter ? 'border-[#81745c] text-[#dfd2ba]' : 'border-[#302e29] text-[#77736c]'}`} aria-pressed={props.taskFilter === filter} data-testid={`button-task-filter-${filter}`}>{filter === 'all' ? 'All tasks' : filter}</button>)}
            </div>
            {filteredTasks.length ? groupByDate(filteredTasks, note => note.createdAt).map(group => (
              <section key={group.date} className="mb-6" data-testid={`library-task-day-${group.date}`}>
                <h3 className="mb-2 text-[10px] font-medium uppercase tracking-[.2em] text-[#777168]">{group.date}</h3>
                {group.notes.map(note => {
                  const progress = checklistProgress(note);
                  const status = progress.isComplete ? 'Complete' : 'Open';
                  return renderNote(note, <span className={`inline-flex items-center gap-1.5 text-[11px] ${progress.isComplete ? 'text-[#a39b82]' : 'text-[#777168]'}`}><span className={`h-1.5 w-1.5 rounded-full ${progress.isComplete ? 'bg-[#a39b82]' : 'bg-[#625d52]'}`} />{status}{progress.total ? ` · ${progress.completed}/${progress.total} done` : ''}</span>);
                })}
              </section>
            )) : <LibraryEmpty message={props.search || props.taskFilter !== 'all' ? 'No tasks match this view.' : 'No tasks here yet.'} />}
          </>}

          {showChecklists && (props.kind !== 'all' || checklists.length > 0) && <>
            {props.kind === 'all' && <h2 className="mb-4 mt-8 text-[10px] font-medium uppercase tracking-[.2em] text-[#595650]">Checklists</h2>}
            {checklists.length ? checklists.map(note => {
              const progress = checklistProgress(note);
              const status = progress.total > 0 && progress.isComplete ? 'Complete' : 'In progress';
              return renderNote(note, <span className={`inline-flex items-center gap-1.5 text-[11px] ${progress.isComplete ? 'text-[#a39b82]' : 'text-[#777168]'}`}><span className={`h-1.5 w-1.5 rounded-full ${progress.isComplete ? 'bg-[#a39b82]' : 'bg-[#625d52]'}`} />{status} · {progress.completed}/{progress.total} done</span>);
            }) : <LibraryEmpty message={props.search ? 'No matching checklists.' : 'No checklists here yet.'} />}
          </>}
        </>
      )}
    </section>
  );
}

function LibraryEmpty(props: { message: string }) {
  return <p className="py-6 font-serif text-base text-[#5e5a53]" data-testid="library-empty">{props.message}</p>;
}

function NoteEditor(props: {
  note: QuietNote;
  settings: QuietSettings;
  saveState: 'saved' | 'saving' | 'error';
  saveMessage: string;
  onSave: (note: QuietNote) => void;
  onBack: () => void;
  onDelete: () => void;
  onSaveMessage: (message: string) => void;
  onSettings: () => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<Range | null>(null);
  const selectedImageRef = useRef<HTMLElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestNoteRef = useRef(props.note);
  const [title, setTitle] = useState(props.note.title);
  const [body, setBody] = useState(props.note.content);
  const [hasSelection, setHasSelection] = useState(false);
  const [imageSelected, setImageSelected] = useState(false);
  const [editorFocused, setEditorFocused] = useState(false);
  const [imageOptions, setImageOptions] = useState<ImageOptions>(defaultImageOptions);
  const [moreOpen, setMoreOpen] = useState(false);
  const writingFontFamily = props.settings.fontFamily === 'Georgia'
    ? 'Georgia, serif'
    : "'Literata', Georgia, serif";

  const selectImage = (figure: HTMLElement | null) => {
    selectedImageRef.current = figure;
    setImageSelected(Boolean(figure));
    if (!figure) return;
    const size = figure.dataset.size;
    const alignment = figure.dataset.align;
    setImageOptions({
      size: size === 'small' || size === 'medium' ? size : 'full',
      alignment: alignment === 'left' || alignment === 'right' ? alignment : 'center',
      wrap: figure.dataset.wrap === 'true',
      caption: figure.querySelector('[data-image-caption]')?.textContent ?? '',
    });
  };

  useEffect(() => {
    const editor = bodyRef.current;
    if (!editor) return;
    editor.innerHTML = props.note.content;
    const checklistMarkupChanged = migrateLegacyChecklistItems(editor);
    const imageMarkupChanged = migrateLegacyImages(editor);
    const migrated = checklistMarkupChanged || imageMarkupChanged;
    if (migrated) {
      const updated = { ...props.note, content: editor.innerHTML };
      latestNoteRef.current = updated;
      setBody(updated.content);
      props.onSave(updated);
    }
  }, [props.note.id]);

  useEffect(() => {
    const handleSelection = () => {
      const selection = window.getSelection();
      if (!selection || !bodyRef.current || !selection.anchorNode || !bodyRef.current.contains(selection.anchorNode)) {
        setHasSelection(false);
        return;
      }
      const selected = selection.toString().length > 0;
      const node = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection.anchorNode.parentElement;
      const image = node?.closest('img');
      const figure = image?.closest('figure[data-note-image]') as HTMLElement | null;
      if (figure) {
        selectImage(figure);
        setHasSelection(false);
      } else if (selected) {
        selectedImageRef.current = null;
        setImageSelected(false);
        setHasSelection(true);
      } else {
        selectedImageRef.current = null;
        setImageSelected(false);
        setHasSelection(false);
      }
      if (selection.rangeCount) rangeRef.current = selection.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', handleSelection);
    return () => document.removeEventListener('selectionchange', handleSelection);
  }, []);

  const flushSave = useCallback((nextTitle: string, nextBody: string) => {
    const current = latestNoteRef.current;
    const content = bodyRef.current ? serializeEditor(bodyRef.current) : nextBody;
    const updated = {
      ...current,
      title: nextTitle,
      content,
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
    };
    latestNoteRef.current = updated;
    props.onSave(updated);
  }, [props.onSave]);

  const updateTaskSchedule = (
    partial: Partial<Pick<QuietNote, 'dueDate' | 'reminderAt' | 'reminderTimezone'>>,
  ) => {
    const updated = mergeTaskSchedule(latestNoteRef.current, partial);
    latestNoteRef.current = updated;
    props.onSave(updated);
  };

  const scheduleSave = useCallback((nextTitle: string, nextBody: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    props.onSaveMessage('');
    timerRef.current = setTimeout(() => flushSave(nextTitle, nextBody), 550);
  }, [flushSave, props.onSaveMessage]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const handleTitle = (value: string) => {
    setTitle(value);
    scheduleSave(value, body);
  };
  const handleBody = () => {
    const value = bodyRef.current ? serializeEditor(bodyRef.current) : '';
    setBody(value);
    scheduleSave(title, value);
  };

  const updateSelectedImage = (partial: Partial<ImageOptions>) => {
    const figure = selectedImageRef.current;
    if (!figure) return;
    const next = { ...imageOptions, ...partial };
    if (next.size !== 'small' || next.alignment === 'center') next.wrap = false;
    figure.dataset.size = next.size;
    figure.dataset.align = next.alignment;
    figure.dataset.wrap = String(next.wrap);
    const caption = figure.querySelector<HTMLElement>('[data-image-caption]');
    if (caption && caption.textContent !== next.caption) caption.textContent = next.caption;
    setImageOptions(next);
    handleBody();
  };

  const moveSelectedImage = (direction: 'up' | 'down') => {
    const figure = selectedImageRef.current;
    if (!figure) return;
    const sibling = direction === 'up' ? figure.previousElementSibling : figure.nextElementSibling;
    if (!isTextBlock(sibling)) return;
    if (direction === 'up') sibling.before(figure);
    else sibling.after(figure);
    handleBody();
  };

  const applyFormat = (command: string) => {
    bodyRef.current?.focus();
    if (rangeRef.current) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(rangeRef.current);
    }
    document.execCommand(command);
    handleBody();
  };

  const insertChecklistItem = () => {
    const editor = bodyRef.current;
    if (!editor) return;
    const row = createChecklistItem();
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const currentItem = anchor
      ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)?.closest('[data-check-item]')
      : null;
    const currentParagraph = anchor
      ? (anchor.nodeType === Node.ELEMENT_NODE ? anchor as Element : anchor.parentElement)?.closest('p')
      : null;
    if (currentItem && editor.contains(currentItem)) currentItem.after(row);
    else if (currentParagraph && editor.contains(currentParagraph)) currentParagraph.after(row);
    else editor.append(row);
    placeCaretAtStart(row.querySelector<HTMLElement>('[data-check-text]')!);
    setEditorFocused(true);
    handleBody();
  };

  const chooseImage = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && bodyRef.current?.contains(selection.anchorNode)) {
      rangeRef.current = selection.getRangeAt(0).cloneRange();
    }
    fileRef.current?.click();
  };

  const insertImage = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      props.onSaveMessage('Choose an image file to insert.');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      props.onSaveMessage('That image is over 12 MB. Choose a smaller one to keep this page quick.');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => props.onSaveMessage('This image could not be read. Please try another file.');
    reader.onload = () => {
      const editor = bodyRef.current;
      if (!editor || typeof reader.result !== 'string') return;
      const image = document.createElement('img');
      image.src = reader.result;
      image.alt = file.name;
      const figure = createImageFigure(image);
      const range = rangeRef.current && editor.contains(rangeRef.current.commonAncestorContainer)
        ? rangeRef.current
        : (() => {
            const next = document.createRange();
            next.selectNodeContents(editor);
            next.collapse(false);
            return next;
          })();
      insertImageFigure(editor, range, figure);
      selectImage(figure);
      setEditorFocused(true);
      handleBody();
    };
    reader.readAsDataURL(file);
  };

  const saveStatus = props.saveState === 'saving' ? 'Saving…' : props.saveState === 'error' ? 'Not saved' : 'Saved on this device';
  const leaveEditor = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (props.saveState === 'error' && !window.confirm('This page has edits that did not save. Leave anyway?')) return;
    flushSave(title, bodyRef.current?.innerHTML ?? body);
    props.onBack();
  };
  const removeCurrentPage = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    props.onDelete();
    setMoreOpen(false);
  };
  const removeSelectedImage = () => {
    selectedImageRef.current?.remove();
    selectImage(null);
    handleBody();
  };

  return (
    <section className="mx-auto flex min-h-[100dvh] w-full max-w-[900px] flex-col px-5 pb-24 pt-5 sm:px-10 sm:pt-8" data-testid="screen-editor">
      <header className="flex min-h-11 items-center justify-between">
        <button onClick={leaveEditor} className="control-focus flex items-center gap-2 rounded-full px-2 py-2 text-sm text-[#89847b] transition hover:text-[#e4dccf]" data-testid="button-back-home">
          <ArrowLeft size={17} strokeWidth={1.6} /><span className="hidden sm:inline">All pages</span>
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-[11px] text-[#66625b]" data-testid="status-save-state">
            {props.saveState === 'saved' ? <Check size={13} className="text-[#807b6e]" /> : null}
            <span>{saveStatus}</span>
          </div>
          <button onClick={props.onSettings} className="control-focus grid h-9 w-9 place-items-center rounded-full text-[#79756e] transition hover:bg-[#141311] hover:text-[#d7d0c4]" aria-label="Writing settings" data-testid="button-editor-settings">
            <Settings size={17} strokeWidth={1.55} />
          </button>
          <div className="relative">
            <button onClick={() => setMoreOpen(value => !value)} className="control-focus grid h-9 w-9 place-items-center rounded-full text-[#79756e] hover:bg-[#141311] hover:text-[#d7d0c4]" aria-label="More note actions" data-testid="button-note-menu">
              <MoreHorizontal size={19} />
            </button>
            {moreOpen && <div className="absolute right-0 top-11 z-10 w-44 rounded-xl border border-[#2d2b27] bg-[#11110f] p-1.5 shadow-xl">
              <button onClick={removeCurrentPage} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-[#c39a8a] hover:bg-[#211917]" data-testid="button-delete-current-note"><Trash2 size={15} /> Delete page</button>
            </div>}
          </div>
        </div>
      </header>

      <div className="mx-auto mt-[clamp(3.2rem,12vh,8rem)] w-full max-w-[680px]">
        <div className="mb-4 flex items-center gap-2 text-[10px] uppercase tracking-[.2em] text-[#625e56]" data-testid="text-note-kind">
          <span>{kindNames[props.note.kind]}</span><span className="text-[#393732]">·</span><span>{formatDate(props.note.createdAt)}</span>
        </div>
        <input
          ref={titleRef}
          value={title}
          onChange={event => handleTitle(event.target.value)}
          placeholder="Untitled"
          aria-label="Page title"
          className="mb-7 w-full border-0 bg-transparent p-0 font-serif text-[clamp(2rem,6vw,3.1rem)] font-normal leading-[1.15] tracking-[-.035em] text-[#e3ddd2] outline-none placeholder:text-[#4a4741]"
          data-testid="input-note-title"
        />
        <div ref={toolbarRef} className="relative mb-5 flex min-h-9 flex-wrap items-center gap-1">
          <button onMouseDown={event => event.preventDefault()} onClick={chooseImage} className="control-focus inline-flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-[#77736c] transition hover:bg-[#151412] hover:text-[#d5cbb8]" data-testid="button-insert-image">
            <ImagePlus size={15} strokeWidth={1.6} /><span>Add image</span>
          </button>
          {(editorFocused || hasSelection || imageSelected) && (
            <>
              {(props.note.kind === 'checklist' || props.note.kind === 'task') && <button onMouseDown={event => event.preventDefault()} onClick={insertChecklistItem} className="control-focus inline-flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-[#77736c] transition hover:bg-[#151412] hover:text-[#d5cbb8]" data-testid="button-add-checklist-item"><ListChecks size={15} />Add item</button>}
              {hasSelection && <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-[#302e29] bg-[#11110f] p-1 soft-in" data-testid="toolbar-formatting">
                <FormatButton label="Bold" icon={<Bold size={15} />} action={() => applyFormat('bold')} id="button-format-bold" />
                <FormatButton label="Italic" icon={<Italic size={15} />} action={() => applyFormat('italic')} id="button-format-italic" />
                <FormatButton label="Underline" icon={<Underline size={15} />} action={() => applyFormat('underline')} id="button-format-underline" />
              </div>}
              {imageSelected && <div className="ml-auto flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-[#302e29] bg-[#11110f] p-2 soft-in" data-testid="toolbar-image">
                <label className="sr-only" htmlFor="image-size">Image size</label>
                <select id="image-size" value={imageOptions.size} onChange={event => updateSelectedImage({ size: event.target.value as ImageSize })} className="control-focus min-h-10 rounded-md border border-[#302e29] bg-[#11110f] px-2 py-1.5 text-xs text-[#c8c1b6]" data-testid="select-image-size">
                  <option value="small">Small</option><option value="medium">Medium</option><option value="full">Full</option>
                </select>
                <div className="flex items-center gap-0.5" role="group" aria-label="Image alignment">
                  <button onMouseDown={event => event.preventDefault()} onClick={() => updateSelectedImage({ alignment: 'left' })} className={`control-focus grid h-10 w-10 place-items-center rounded-md ${imageOptions.alignment === 'left' ? 'bg-[#25231e] text-[#e1d7c4]' : 'text-[#9a958a]'}`} aria-label="Align image left" aria-pressed={imageOptions.alignment === 'left'} data-testid="button-image-align-left"><AlignLeft size={15} /></button>
                  <button onMouseDown={event => event.preventDefault()} onClick={() => updateSelectedImage({ alignment: 'center' })} className={`control-focus grid h-10 w-10 place-items-center rounded-md ${imageOptions.alignment === 'center' ? 'bg-[#25231e] text-[#e1d7c4]' : 'text-[#9a958a]'}`} aria-label="Align image center" aria-pressed={imageOptions.alignment === 'center'} data-testid="button-image-align-center"><AlignCenter size={15} /></button>
                  <button onMouseDown={event => event.preventDefault()} onClick={() => updateSelectedImage({ alignment: 'right' })} className={`control-focus grid h-10 w-10 place-items-center rounded-md ${imageOptions.alignment === 'right' ? 'bg-[#25231e] text-[#e1d7c4]' : 'text-[#9a958a]'}`} aria-label="Align image right" aria-pressed={imageOptions.alignment === 'right'} data-testid="button-image-align-right"><AlignRight size={15} /></button>
                </div>
                <button onMouseDown={event => event.preventDefault()} onClick={() => updateSelectedImage({ wrap: !imageOptions.wrap })} disabled={imageOptions.size !== 'small' || imageOptions.alignment === 'center'} className="control-focus min-h-10 rounded-md px-2.5 py-1.5 text-xs text-[#aaa398] hover:bg-[#25231e] disabled:cursor-not-allowed disabled:opacity-40" aria-pressed={imageOptions.wrap} data-testid="button-image-wrap">Wrap text</button>
                <div className="flex items-center gap-0.5" role="group" aria-label="Move image between paragraphs">
                  <button onMouseDown={event => event.preventDefault()} onClick={() => moveSelectedImage('up')} disabled={!isTextBlock(selectedImageRef.current?.previousElementSibling)} className="control-focus grid h-10 w-10 place-items-center rounded-md text-[#9a958a] hover:bg-[#25231e] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Move image above previous text block" title="Move image up" data-testid="button-image-move-up"><ArrowUp size={16} /></button>
                  <button onMouseDown={event => event.preventDefault()} onClick={() => moveSelectedImage('down')} disabled={!isTextBlock(selectedImageRef.current?.nextElementSibling)} className="control-focus grid h-10 w-10 place-items-center rounded-md text-[#9a958a] hover:bg-[#25231e] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Move image below next text block" title="Move image down" data-testid="button-image-move-down"><ArrowDown size={16} /></button>
                </div>
                <input value={imageOptions.caption} onChange={event => updateSelectedImage({ caption: event.target.value })} placeholder="Caption" aria-label="Image caption" className="control-focus min-h-10 min-w-[90px] flex-1 rounded-md border border-[#302e29] bg-transparent px-2.5 py-1.5 text-xs text-[#c8c1b6] placeholder:text-[#615d55]" data-testid="input-image-caption" />
                <button onMouseDown={event => event.preventDefault()} onClick={removeSelectedImage} className="control-focus min-h-10 rounded-md px-2.5 py-1.5 text-xs text-[#c39a8a] hover:bg-[#251a17]" data-testid="button-remove-image">Remove</button>
              </div>}
            </>
          )}
        </div>
        {props.note.kind === 'task' && (
          <div className="mb-6 flex flex-wrap gap-x-6 gap-y-4 rounded-xl border border-[#25231f] bg-[#10100e] px-4 py-3" data-testid="task-schedule-fields">
            <label className="flex min-w-[150px] flex-1 flex-col gap-1.5 text-[10px] uppercase tracking-[.14em] text-[#716b60]">
              Due date
              <input
                type="date"
                value={props.note.dueDate ?? ''}
                onChange={event => updateTaskSchedule({ dueDate: event.target.value || undefined })}
                className="control-focus min-h-10 rounded-md border border-[#302e29] bg-[#11110f] px-2.5 text-sm normal-case tracking-normal text-[#c8c1b6] [color-scheme:dark]"
                aria-label="Task due date"
                data-testid="input-task-due-date"
              />
            </label>
            <label className="flex min-w-[190px] flex-1 flex-col gap-1.5 text-[10px] uppercase tracking-[.14em] text-[#716b60]">
              Reminder · local time
              <input
                type="datetime-local"
                value={localDateTimeInput(props.note.reminderAt)}
                onChange={event => {
                  const reminderAt = event.target.value ? new Date(event.target.value).getTime() : undefined;
                  const validReminder = reminderAt !== undefined && Number.isFinite(reminderAt);
                  updateTaskSchedule({
                    reminderAt: validReminder ? reminderAt : undefined,
                    reminderTimezone: validReminder ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
                  });
                }}
                className="control-focus min-h-10 rounded-md border border-[#302e29] bg-[#11110f] px-2.5 text-sm normal-case tracking-normal text-[#c8c1b6] [color-scheme:dark]"
                aria-label="Task reminder date and time"
                data-testid="input-task-reminder-time"
              />
            </label>
          </div>
        )}
        <div
          ref={bodyRef}
          className="note-body min-h-[42vh] font-[var(--editor-font)] text-[#cfc9bf] caret-[#d1bd98] selection:bg-[#594d37]"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label="Write your page"
          aria-multiline="true"
          data-placeholder={props.note.kind === 'journal' ? 'Begin with what stayed with you…' : props.note.kind === 'task' ? 'What needs doing?' : props.note.kind === 'checklist' ? 'Add a thought, then make a list…' : 'Begin anywhere…'}
          style={{ fontFamily: writingFontFamily, fontSize: `${props.settings.fontSize}px`, lineHeight: props.settings.lineSpacing }}
          onInput={handleBody}
          onFocus={() => setEditorFocused(true)}
          onBlur={event => {
            if (event.relatedTarget && toolbarRef.current?.contains(event.relatedTarget as Node)) return;
            setEditorFocused(false);
          }}
          onClick={event => {
            const target = event.target;
            if (target instanceof HTMLInputElement && target.type === 'checkbox') {
              window.setTimeout(() => {
                if (!bodyRef.current?.contains(target)) return;
                if (target.checked) target.setAttribute('checked', '');
                else target.removeAttribute('checked');
                handleBody();
              }, 0);
              return;
            }
            if (target instanceof HTMLImageElement) {
              selectImage(target.closest('figure[data-note-image]') as HTMLElement | null);
              setEditorFocused(true);
            } else if (target instanceof HTMLElement && !target.closest('[data-note-image]')) {
              selectImage(null);
            }
          }}
          onKeyDown={event => {
            const target = event.target;
            const selectionAnchor = window.getSelection()?.anchorNode;
            const selectionElement = selectionAnchor?.nodeType === Node.ELEMENT_NODE
              ? selectionAnchor as Element
              : selectionAnchor?.parentElement;
            const checkText = (target instanceof HTMLElement ? target.closest<HTMLElement>('[data-check-text]') : null)
              ?? selectionElement?.closest<HTMLElement>('[data-check-text]')
              ?? null;
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && checkText) {
              event.preventDefault();
              const row = checkText.closest<HTMLElement>('[data-check-item]');
              if (checkText.textContent?.trim()) {
                const next = createChecklistItem();
                row?.after(next);
                placeCaretAtStart(next.querySelector<HTMLElement>('[data-check-text]')!);
              } else {
                const outsideParagraph = document.createElement('p');
                outsideParagraph.innerHTML = '<br>';
                row?.after(outsideParagraph);
                row?.remove();
                placeCaretAtStart(outsideParagraph);
              }
              handleBody();
              return;
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (timerRef.current) clearTimeout(timerRef.current);
              flushSave(title, bodyRef.current ? serializeEditor(bodyRef.current) : body);
            }
          }}
          data-testid="editor-rich-content"
        />
        <input ref={fileRef} type="file" accept="image/*" onChange={insertImage} className="hidden" data-testid="input-image-file" />
        {props.saveMessage && <p className="mt-5 text-sm text-[#c39380]" data-testid="status-editor-message">{props.saveMessage}</p>}
        {props.saveState === 'error' && <button onClick={() => flushSave(title, bodyRef.current?.innerHTML ?? body)} className="mt-4 text-xs text-[#c3aa82] underline underline-offset-4" data-testid="button-retry-note-save">Retry saving this page</button>}
      </div>
    </section>
  );
}

function FormatButton(props: { label: string; icon: ReactNode; action: () => void; id: string }) {
  return <button title={props.label} aria-label={props.label} onMouseDown={event => event.preventDefault()} onClick={props.action} className="control-focus grid h-8 w-8 place-items-center rounded-md text-[#9a958a] hover:bg-[#25231e] hover:text-[#e1d7c4]" data-testid={props.id}>{props.icon}</button>;
}

type DataBackupProps = {
  busy: boolean;
  preview: BackupPreview | null;
  strategy: ImportStrategy;
  status: BackupStatus | null;
  onExport: () => void;
  onSelectFile: (file?: File) => void;
  onStrategyChange: (strategy: ImportStrategy) => void;
  onImport: () => void;
  onCancelImport: () => void;
};

type CloudSyncProps = {
  configured: boolean;
  user: User | null;
  loading: boolean;
  busy: boolean;
  status: string;
  email: string;
  password: string;
  onEmailChange: (email: string) => void;
  onPasswordChange: (password: string) => void;
  onSignIn: () => void;
  onCreateAccount: () => void;
  onSignOut: () => void;
  onSync: () => void;
  conflicts: NoteSyncConflict[];
  onResolve: (conflict: NoteSyncConflict, choice: 'device' | 'cloud') => void;
};

function SettingsScreen(props: {
  settings: QuietSettings;
  onChange: (settings: QuietSettings) => void;
  onBack: () => void;
  reminders?: {
    permission: ReminderPermission;
    status: string;
    onEnable: () => void;
    onTest: () => void;
  };
  cloudSync?: CloudSyncProps;
  dataBackup?: DataBackupProps;
}) {
  const update = (partial: Partial<QuietSettings>) => props.onChange({ ...props.settings, ...partial });
  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-[720px] px-6 pb-20 pt-6 sm:px-10 sm:pt-9" data-testid="screen-settings">
      <header className="flex items-center">
        <button onClick={props.onBack} className="control-focus flex items-center gap-2 rounded-full px-2 py-2 text-sm text-[#89847b] hover:text-[#e4dccf]" data-testid="button-settings-back"><ArrowLeft size={17} strokeWidth={1.6} /><span>Back</span></button>
      </header>
      <div className="mt-[clamp(3rem,12vh,7rem)]">
        <p className="mb-3 text-[10px] uppercase tracking-[.22em] text-[#6b665d]">Your space</p>
        <h1 className="m-0 font-serif text-4xl font-normal tracking-[-.03em] text-[#e1dbcf]">Writing, your way.</h1>
        <p className="mt-3 max-w-md font-serif text-base leading-relaxed text-[#777168]">A few quiet choices for how your words sit on the page.</p>
      </div>
      <div className="mt-14 divide-y divide-[#201f1c] border-y border-[#201f1c]">
        <div className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="m-0 text-sm font-medium text-[#d5cec2]">Type</h2><p className="mb-0 mt-1 text-xs text-[#68645d]">The voice of your page</p></div>
          <div className="flex gap-2" role="group" aria-label="Writing font">
            {(['Literata', 'Georgia'] as const).map(font => <button key={font} onClick={() => update({ fontFamily: font })} className={`control-focus rounded-full border px-4 py-2 text-sm transition ${props.settings.fontFamily === font ? 'border-[#81745c] bg-[#191711] text-[#dfd2ba]' : 'border-[#302e29] text-[#77736c] hover:border-[#625b4c]'}`} data-testid={`button-font-${font.toLowerCase()}`}>{font}</button>)}
          </div>
        </div>
        <div className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="m-0 text-sm font-medium text-[#d5cec2]">Letter size</h2><p className="mb-0 mt-1 text-xs text-[#68645d]">Comfort, not a fixed rule</p></div>
          <div className="flex items-center gap-4">
            <span className="font-serif text-sm text-[#827c71]">A</span>
            <input type="range" min="16" max="30" step="1" value={props.settings.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} className="w-40 accent-[#b6a27e]" aria-label="Writing font size" data-testid="input-font-size" />
            <span className="font-serif text-2xl text-[#cfc5b1]">A</span>
            <span className="w-7 text-right text-xs tabular-nums text-[#716b60]" data-testid="text-font-size-value">{props.settings.fontSize}</span>
          </div>
        </div>
        <div className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 className="m-0 text-sm font-medium text-[#d5cec2]">Line spacing</h2><p className="mb-0 mt-1 text-xs text-[#68645d]">Room between each thought</p></div>
          <div className="flex gap-2" role="group" aria-label="Line spacing">
            {[1.5, 1.8, 2.1].map(value => <button key={value} onClick={() => update({ lineSpacing: value })} className={`control-focus rounded-full border px-4 py-2 text-sm transition ${props.settings.lineSpacing === value ? 'border-[#81745c] bg-[#191711] text-[#dfd2ba]' : 'border-[#302e29] text-[#77736c] hover:border-[#625b4c]'}`} data-testid={`button-line-spacing-${value}`}>{value === 1.5 ? 'Close' : value === 1.8 ? 'Easy' : 'Open'}</button>)}
          </div>
        </div>
      </div>
      <div className="mt-10 flex items-start gap-3 text-xs leading-relaxed text-[#5e5a53]" data-testid="text-local-storage-note">
        <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#82745b]" />
        <p className="m-0">Your pages and preferences stay in this browser on this device. They are not sent anywhere.</p>
      </div>
      {props.reminders && (
        <section className="mt-12 border-t border-[#201f1c] pt-8" aria-labelledby="heading-task-reminders" data-testid="section-task-reminders">
          <h2 id="heading-task-reminders" className="m-0 text-sm font-medium text-[#d5cec2]">Task reminders</h2>
          <p className="mb-0 mt-2 max-w-lg text-xs leading-relaxed text-[#777168]">
            {props.reminders.permission === 'granted'
              ? 'Browser reminders require this tab to remain open. Closed-browser delivery needs a configured background notification service worker.'
              : 'Allow notifications on this device to receive reminders for tasks with a reminder date and time.'}
          </p>
          <button
            type="button"
            onClick={props.reminders.onEnable}
            disabled={props.reminders.permission === 'unsupported'}
            className="control-focus mt-4 inline-flex min-h-10 items-center gap-2 rounded-full border border-[#3a362d] px-4 text-xs text-[#d8cfbe] transition hover:border-[#6a604c] hover:bg-[#161511] disabled:opacity-50"
            data-testid="button-enable-reminders"
          >
            <Bell size={14} strokeWidth={1.7} />
            {props.reminders.permission === 'granted' ? 'Refresh notification permission' : 'Enable notifications'}
          </button>
          <button
            type="button"
            onClick={props.reminders.onTest}
            disabled={props.reminders.permission !== 'granted'}
            className="control-focus ml-2 mt-4 inline-flex min-h-10 items-center rounded-full border border-[#3a362d] px-4 text-xs text-[#d8cfbe] transition hover:border-[#6a604c] hover:bg-[#161511] disabled:opacity-50"
            data-testid="button-test-notification"
          >
            Send test notification
          </button>
          {props.reminders.status && <pre role="status" className="mb-0 mt-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-[#827c71]" data-testid="status-task-reminders">{props.reminders.status}</pre>}
        </section>
      )}
      {props.cloudSync && (
        <section className="mt-12 border-t border-[#201f1c] pt-8" aria-labelledby="heading-cloud-sync" data-testid="section-cloud-sync">
          <h2 id="heading-cloud-sync" className="m-0 text-sm font-medium text-[#d5cec2]">Cloud sync</h2>
          <p className="mb-0 mt-2 max-w-lg text-xs leading-relaxed text-[#777168]">Sign in on each device to sync notes. Local edits continue to work offline; changes sync when this app is online. Conflicting edits are kept for you to choose between.</p>
          {!props.cloudSync.configured ? (
            <p className="mb-0 mt-4 rounded-lg border border-[#51452f] bg-[#1d1911] px-4 py-3 text-xs leading-relaxed text-[#d8c8a6]" role="status" data-testid="status-firebase-setup">
              In Firebase Console, open Project settings (gear) → General → Your apps → your Web app → SDK setup and configuration → Config. Copy its five values into <code>artifacts/quiet-notes/.env.local</code> using the names <code>VITE_FIREBASE_API_KEY</code>, <code>VITE_FIREBASE_AUTH_DOMAIN</code>, <code>VITE_FIREBASE_PROJECT_ID</code>, <code>VITE_FIREBASE_STORAGE_BUCKET</code>, and <code>VITE_FIREBASE_APP_ID</code>, then rebuild. For GitHub Actions APK builds, set the same values under repository Settings → Secrets and variables → Actions → Variables.
            </p>
          ) : props.cloudSync.user ? (
            <div className="mt-4">
              <p className="text-xs text-[#9a9488]" data-testid="text-cloud-account">Signed in as {props.cloudSync.user.email ?? props.cloudSync.user.uid}</p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button type="button" disabled={props.cloudSync.busy} onClick={props.cloudSync.onSync} className="control-focus min-h-10 rounded-full border border-[#3a362d] px-4 text-xs text-[#d8cfbe] hover:border-[#6a604c] disabled:opacity-50" data-testid="button-sync-now">{props.cloudSync.busy ? 'Syncing…' : 'Sync now'}</button>
                <button type="button" disabled={props.cloudSync.busy} onClick={props.cloudSync.onSignOut} className="control-focus min-h-10 rounded-full px-4 text-xs text-[#8d877b] hover:text-[#d2cabb] disabled:opacity-50" data-testid="button-cloud-sign-out">Sign out</button>
              </div>
            </div>
          ) : (
            <div className="mt-4 max-w-md space-y-3">
              <label className="block text-xs text-[#8d877b]">Email
                <input type="email" autoComplete="email" value={props.cloudSync?.email ?? ''} onChange={event => props.cloudSync?.onEmailChange(event.target.value)} className="control-focus mt-1 min-h-11 w-full rounded-md border border-[#302e29] bg-[#11110f] px-3 text-sm text-[#d2cabb]" data-testid="input-cloud-email" />
              </label>
              <label className="block text-xs text-[#8d877b]">Password
                <input type="password" autoComplete="current-password" value={props.cloudSync?.password ?? ''} onChange={event => props.cloudSync?.onPasswordChange(event.target.value)} className="control-focus mt-1 min-h-11 w-full rounded-md border border-[#302e29] bg-[#11110f] px-3 text-sm text-[#d2cabb]" data-testid="input-cloud-password" />
              </label>
              <div className="flex flex-wrap gap-3">
                <button type="button" disabled={props.cloudSync.loading || props.cloudSync.busy || !props.cloudSync.email || !props.cloudSync.password} onClick={props.cloudSync.onSignIn} className="control-focus min-h-10 rounded-full bg-[#d0c2a6] px-5 text-xs text-[#171510] hover:bg-[#e0d3b8] disabled:opacity-50" data-testid="button-cloud-sign-in">Sign in</button>
                <button type="button" disabled={props.cloudSync.loading || props.cloudSync.busy || !props.cloudSync.email || !props.cloudSync.password} onClick={props.cloudSync.onCreateAccount} className="control-focus min-h-10 rounded-full border border-[#3a362d] px-4 text-xs text-[#d8cfbe] hover:border-[#6a604c] disabled:opacity-50" data-testid="button-cloud-create-account">Create account</button>
              </div>
            </div>
          )}
          {props.cloudSync.status && <p role="status" className="mb-0 mt-3 text-xs leading-relaxed text-[#827c71]" data-testid="status-cloud-sync">{props.cloudSync.status}</p>}
          {props.cloudSync.conflicts.length > 0 && (
            <div className="mt-5 space-y-3" data-testid="list-sync-conflicts">
              {props.cloudSync.conflicts.map(conflict => (
                <article key={conflict.id} className="rounded-lg border border-[#51452f] bg-[#1d1911] p-4" data-testid={`conflict-note-${conflict.id}`}>
                  <h3 className="m-0 text-sm text-[#d5cec2]">{conflict.localNote?.title || conflict.cloudNote.title || 'Untitled task'}</h3>
                  <p className="mb-3 mt-2 text-xs leading-relaxed text-[#9a8d72]">{conflict.localNote ? 'This note changed on this device and in the cloud. Neither copy was overwritten; choose which version to keep.' : 'This note was deleted on this device but changed in the cloud. Choose whether to keep the deletion or restore the cloud copy.'}</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" disabled={props.cloudSync?.busy} onClick={() => props.cloudSync?.onResolve(conflict, 'device')} className="control-focus min-h-10 rounded-full border border-[#3a362d] px-4 text-xs text-[#d8cfbe] disabled:opacity-50" data-testid={`button-conflict-device-${conflict.id}`}>{conflict.localNote ? 'Keep this device' : 'Keep deletion'}</button>
                    <button type="button" disabled={props.cloudSync?.busy} onClick={() => props.cloudSync?.onResolve(conflict, 'cloud')} className="control-focus min-h-10 rounded-full border border-[#3a362d] px-4 text-xs text-[#d8cfbe] disabled:opacity-50" data-testid={`button-conflict-cloud-${conflict.id}`}>Use cloud version</button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
      {props.dataBackup && (
        <section className="mt-16 border-t border-[#201f1c] pt-10" aria-labelledby="heading-data-backup" data-testid="section-data-backup">
          <p className="mb-3 text-[10px] uppercase tracking-[.22em] text-[#6b665d]">Take it with you</p>
          <h2 id="heading-data-backup" className="m-0 font-serif text-3xl font-normal tracking-[-.03em] text-[#e1dbcf]">Data &amp; Backup</h2>
          <p className="mt-3 max-w-lg font-serif text-base leading-relaxed text-[#777168]">Export a local copy of your notes and preferences, or restore them from a backup file. Nothing is uploaded.</p>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              disabled={props.dataBackup.busy}
              onClick={props.dataBackup.onExport}
              className="control-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-[#3a362d] px-5 text-sm text-[#d8cfbe] transition hover:border-[#6a604c] hover:bg-[#161511] disabled:opacity-50"
              data-testid="button-export-backup"
            >
              <Download size={16} strokeWidth={1.7} /> Export backup
            </button>
            <label className={`control-focus inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-full border border-[#3a362d] px-5 text-sm text-[#d8cfbe] transition hover:border-[#6a604c] hover:bg-[#161511] ${props.dataBackup.busy ? 'pointer-events-none opacity-50' : ''}`}>
              <Upload size={16} strokeWidth={1.7} /> Choose backup file
              <input
                type="file"
                accept=".json,application/json"
                className="sr-only"
                disabled={props.dataBackup.busy}
                aria-label="Choose a Quiet Notes JSON backup"
                data-testid="input-import-backup"
                onChange={event => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = '';
                  props.dataBackup?.onSelectFile(file);
                }}
              />
            </label>
          </div>
          {props.dataBackup.status && (
            <p
              role={props.dataBackup.status.kind === 'error' ? 'alert' : 'status'}
              className={`mt-4 rounded-lg border px-4 py-3 text-sm leading-relaxed ${
                props.dataBackup.status.kind === 'error'
                  ? 'border-[#5a342c] bg-[#21110e] text-[#e7c5b8]'
                  : props.dataBackup.status.kind === 'success'
                    ? 'border-[#35402c] bg-[#141910] text-[#c6d2b9]'
                    : 'border-[#51452f] bg-[#1d1911] text-[#d8c8a6]'
              }`}
              data-testid="status-backup"
            >
              {props.dataBackup.status.text}
            </p>
          )}
          {props.dataBackup.preview && (
            <div className="mt-6 rounded-xl border border-[#302d26] bg-[#11110f] p-5" data-testid="panel-backup-preview">
              <h3 className="m-0 text-sm font-medium text-[#d5cec2]">Review this backup</h3>
              <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-[#716b60]">Notes</dt><dd className="mb-0 mt-1 text-[#d2cabb]">{props.dataBackup.preview.backup.notes.length}</dd></div>
                <div><dt className="text-xs text-[#716b60]">Tags</dt><dd className="mb-0 mt-1 text-[#d2cabb]">{props.dataBackup.preview.backup.tags.length}</dd></div>
                <div><dt className="text-xs text-[#716b60]">Embedded images</dt><dd className="mb-0 mt-1 text-[#d2cabb]">{props.dataBackup.preview.imageCount}</dd></div>
                <div><dt className="text-xs text-[#716b60]">Matching IDs</dt><dd className="mb-0 mt-1 text-[#d2cabb]">{props.dataBackup.preview.duplicateIds.length}</dd></div>
              </dl>
              <p className="mb-0 mt-4 text-xs leading-relaxed text-[#827c71]">Confirming imports the listed notes and restores the backup's writing preferences. Existing notes are never deleted.</p>
              {props.dataBackup.preview.duplicateIds.length > 0 && (
                <fieldset className="mt-5 space-y-3 border-0 p-0">
                  <legend className="mb-3 text-xs font-medium text-[#bcb3a2]">How should matching note IDs be handled?</legend>
                  <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-[#9a9488]">
                    <input
                      type="radio"
                      name="backup-duplicate-strategy"
                      value="merge"
                      checked={props.dataBackup.strategy === 'merge'}
                      onChange={() => props.dataBackup?.onStrategyChange('merge')}
                      className="mt-0.5 accent-[#b6a27e]"
                      data-testid="radio-backup-merge"
                    />
                    <span><strong className="font-medium text-[#d2cabb]">Merge non-conflicting notes.</strong> Add notes with new IDs and leave matching existing notes unchanged.</span>
                  </label>
                  <label className="flex cursor-pointer items-start gap-3 text-xs leading-relaxed text-[#9a9488]">
                    <input
                      type="radio"
                      name="backup-duplicate-strategy"
                      value="skip-backup-on-conflict"
                      checked={props.dataBackup.strategy === 'skip-backup-on-conflict'}
                      onChange={() => props.dataBackup?.onStrategyChange('skip-backup-on-conflict')}
                      className="mt-0.5 accent-[#b6a27e]"
                      data-testid="radio-backup-skip"
                    />
                    <span><strong className="font-medium text-[#d2cabb]">Skip the entire backup.</strong> Import nothing, including preferences, if any note ID already exists.</span>
                  </label>
                </fieldset>
              )}
              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={props.dataBackup.busy}
                  onClick={props.dataBackup.onImport}
                  className="control-focus min-h-10 rounded-full bg-[#d0c2a6] px-5 text-sm text-[#171510] transition hover:bg-[#e0d3b8] disabled:opacity-50"
                  data-testid="button-confirm-import"
                >
                  {props.dataBackup.busy ? 'Importing…' : 'Import backup'}
                </button>
                <button
                  type="button"
                  disabled={props.dataBackup.busy}
                  onClick={props.dataBackup.onCancelImport}
                  className="control-focus min-h-10 rounded-full px-4 text-sm text-[#8d877b] hover:text-[#d2cabb] disabled:opacity-50"
                  data-testid="button-cancel-import"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={AppSurface} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
