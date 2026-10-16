import { type ChangeEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  ArrowLeft, Bold, Check, Clock3, FileText, ImagePlus, Italic,
  ListChecks, ListTodo, MoreHorizontal, Plus, Search, Settings, Trash2, Underline,
  X,
} from 'lucide-react';
import {
  defaultSettings, newNote, quietStorage,
  type NoteKind, type QuietNote, type QuietSettings,
} from './quiet-storage';

const queryClient = new QueryClient();
const kindNames: Record<NoteKind, string> = {
  note: 'Note',
  task: 'Task',
  journal: 'Journal',
  checklist: 'Checklist',
};

function formatDate(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `Today · ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function notePreview(note: QuietNote) {
  const text = note.content.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').trim();
  return text || (note.kind === 'checklist' ? 'A list, waiting to be made.' : 'An open page.');
}

function AppSurface() {
  const [notes, setNotes] = useState<QuietNote[]>([]);
  const [settings, setSettings] = useState<QuietSettings>(defaultSettings);
  const [screen, setScreen] = useState<'home' | 'editor' | 'settings'>('home');
  const [activeNote, setActiveNote] = useState<QuietNote | null>(null);
  const [search, setSearch] = useState('');
  const [kindMenu, setKindMenu] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [saveMessage, setSaveMessage] = useState('');

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

  useEffect(() => { void refreshNotes(); }, [refreshNotes]);

  const updateNoteMemory = useCallback((updated: QuietNote) => {
    setNotes(current => [updated, ...current.filter(item => item.id !== updated.id)]
      .sort((a, b) => b.recentlyOpenedAt - a.recentlyOpenedAt));
    setActiveNote(updated);
  }, []);

  const openNote = useCallback(async (note: QuietNote) => {
    const opened = { ...note, recentlyOpenedAt: Date.now() };
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
  }, [activeNote]);

  const savePreferences = useCallback(async (next: QuietSettings) => {
    setSettings(next);
    try {
      await quietStorage.saveSettings(next);
      setStoreError('');
    } catch (error) {
      setStoreError(error instanceof Error ? error.message : 'Your preferences could not be saved.');
    }
  }, []);

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
          <button className="control-focus rounded px-2 py-1 text-xs underline underline-offset-4" onClick={() => screen === 'settings' ? void savePreferences(settings) : activeNote ? void persistNote(activeNote) : void refreshNotes()} data-testid="button-retry-storage">Retry</button>
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
          onOpen={note => void openNote(note)}
          onDelete={note => void deleteNote(note)}
          kindMenu={kindMenu}
          onPickKind={kind => void createNote(kind)}
          onSettings={() => { setKindMenu(false); setScreen('settings'); }}
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
          onBack={() => { setScreen('home'); setKindMenu(false); }}
          onDelete={() => void deleteNote(activeNote)}
          onSaveMessage={setSaveMessage}
        />
      )}

      {screen === 'settings' && (
        <SettingsScreen
          settings={settings}
          onChange={value => void savePreferences(value)}
          onBack={() => setScreen('home')}
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
            <h1 className="m-0 font-[var(--app-font-serif)] text-[clamp(2rem,5vw,3.15rem)] font-normal leading-tight tracking-[-.035em] text-[#ded8cd]">A little room to think.</h1>
            <p className="mb-0 mt-3 font-[var(--app-font-serif)] text-base text-[#69655f]">Come back to what matters.</p>
          </div>
          <div className="relative shrink-0">
            <button onClick={props.onCreate} aria-label="Create a page" className="control-focus grid h-[50px] w-[50px] place-items-center rounded-full border border-[#4a443a] bg-[#c9b999] text-[#171511] transition hover:bg-[#ddcdb0]" data-testid="button-create-note">
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
                <h2 className="m-0 truncate font-[var(--app-font-serif)] text-[19px] font-normal text-[#d6d0c5] group-hover:text-[#eee7dc]">{note.title.trim() || kindNames[note.kind]}</h2>
                <span className="shrink-0 text-[11px] text-[#5f5c56]" data-testid={`text-updated-${note.id}`}>{formatDate(note.updatedAt)}</span>
              </div>
              <p className="m-0 truncate font-[var(--app-font-serif)] text-sm leading-relaxed text-[#74706a]" data-testid={`text-preview-${note.id}`}>{notePreview(note)}</p>
            </button>
            <button onClick={() => props.onDelete(note)} className="control-focus mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-[#57544e] opacity-0 transition hover:bg-[#211a18] hover:text-[#c38f7e] focus:opacity-100 group-hover:opacity-100" aria-label={`Delete ${note.title || kindNames[note.kind]}`} data-testid={`button-delete-note-${note.id}`}>
              <Trash2 size={15} strokeWidth={1.6} />
            </button>
          </article>
        ))}
        {!props.loading && !props.loadError && props.notes.length === 0 && (
          <div className="py-12" data-testid="empty-notes">
            <p className="m-0 font-[var(--app-font-serif)] text-xl text-[#777168]">{props.search ? 'Nothing found.' : 'The page is yours.'}</p>
            <p className="mb-0 mt-2 max-w-sm font-[var(--app-font-serif)] text-sm leading-relaxed text-[#514e48]">{props.search ? 'Try another word, or clear your search.' : 'Start anywhere. A thought, a list, a day worth keeping.'}</p>
          </div>
        )}
      </div>
      {props.totalNotes > 0 && <p className="mt-9 text-[11px] tracking-wide text-[#484640]" data-testid="text-note-count">{props.totalNotes} {props.totalNotes === 1 ? 'page' : 'pages'} kept here</p>}
    </section>
  );
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
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rangeRef = useRef<Range | null>(null);
  const selectedImageRef = useRef<HTMLImageElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestNoteRef = useRef(props.note);
  const [title, setTitle] = useState(props.note.title);
  const [body, setBody] = useState(props.note.content);
  const [hasSelection, setHasSelection] = useState(false);
  const [imageSelected, setImageSelected] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => { if (bodyRef.current) bodyRef.current.innerHTML = props.note.content; }, [props.note.id]);

  useEffect(() => {
    const handleSelection = () => {
      const selection = window.getSelection();
      if (!selection || !bodyRef.current || !selection.anchorNode || !bodyRef.current.contains(selection.anchorNode)) {
        setHasSelection(false);
        setImageSelected(false);
        return;
      }
      const selected = selection.toString().length > 0;
      setHasSelection(selected);
      const node = selection.anchorNode.nodeType === Node.ELEMENT_NODE ? selection.anchorNode as Element : selection.anchorNode.parentElement;
      const image = node?.closest('img') as HTMLImageElement | null;
      selectedImageRef.current = image;
      setImageSelected(Boolean(image));
      if (selection.rangeCount) rangeRef.current = selection.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', handleSelection);
    return () => document.removeEventListener('selectionchange', handleSelection);
  }, []);

  const flushSave = useCallback((nextTitle: string, nextBody: string) => {
    const current = latestNoteRef.current;
    const updated = { ...current, title: nextTitle, content: nextBody, updatedAt: Date.now() };
    latestNoteRef.current = updated;
    props.onSave(updated);
  }, [props.onSave]);

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
    const value = bodyRef.current?.innerHTML ?? '';
    setBody(value);
    scheduleSave(title, value);
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
    bodyRef.current?.focus();
    document.execCommand('insertHTML', false, '<ul><li data-check-item><input type="checkbox"> </li></ul><p><br></p>');
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
      editor.focus();
      const selection = window.getSelection();
      if (rangeRef.current) {
        selection?.removeAllRanges();
        selection?.addRange(rangeRef.current);
      }
      document.execCommand('insertHTML', false, `<img src="${reader.result}" alt="${file.name.replace(/[&"'<>]/g, '')}"><p><br></p>`);
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
    selectedImageRef.current = null;
    setImageSelected(false);
    handleBody();
  };

  return (
    <section className="mx-auto flex min-h-[100dvh] w-full max-w-[900px] flex-col px-5 pb-24 pt-5 sm:px-10 sm:pt-8" data-testid="screen-editor">
      <header className="flex min-h-11 items-center justify-between">
        <button onClick={leaveEditor} className="control-focus flex items-center gap-2 rounded-full px-2 py-2 text-sm text-[#89847b] transition hover:text-[#e4dccf]" data-testid="button-back-home">
          <ArrowLeft size={17} strokeWidth={1.6} /><span className="hidden sm:inline">All pages</span>
        </button>
        <div className="flex items-center gap-2 text-[11px] text-[#66625b]" data-testid="status-save-state">
          {props.saveState === 'saved' ? <Check size={13} className="text-[#807b6e]" /> : null}
          <span>{saveStatus}</span>
        </div>
        <div className="relative">
          <button onClick={() => setMoreOpen(value => !value)} className="control-focus grid h-9 w-9 place-items-center rounded-full text-[#79756e] hover:bg-[#141311] hover:text-[#d7d0c4]" aria-label="More note actions" data-testid="button-note-menu">
            <MoreHorizontal size={19} />
          </button>
          {moreOpen && <div className="absolute right-0 top-11 z-10 w-44 rounded-xl border border-[#2d2b27] bg-[#11110f] p-1.5 shadow-xl">
            <button onClick={removeCurrentPage} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-[#c39a8a] hover:bg-[#211917]" data-testid="button-delete-current-note"><Trash2 size={15} /> Delete page</button>
          </div>}
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
          className="mb-7 w-full border-0 bg-transparent p-0 font-[var(--app-font-serif)] text-[clamp(2rem,6vw,3.1rem)] font-normal leading-[1.15] tracking-[-.035em] text-[#e3ddd2] outline-none placeholder:text-[#4a4741]"
          data-testid="input-note-title"
        />
        <div className="relative mb-5 flex min-h-9 items-center gap-1">
          <button onMouseDown={event => event.preventDefault()} onClick={chooseImage} className="control-focus inline-flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-[#77736c] transition hover:bg-[#151412] hover:text-[#d5cbb8]" data-testid="button-insert-image">
            <ImagePlus size={15} strokeWidth={1.6} /><span>Add image</span>
          </button>
          {(props.note.kind === 'checklist' || props.note.kind === 'task') && <button onMouseDown={event => event.preventDefault()} onClick={insertChecklistItem} className="control-focus inline-flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-[#77736c] transition hover:bg-[#151412] hover:text-[#d5cbb8]" data-testid="button-add-checklist-item"><ListChecks size={15} />Add item</button>}
          {hasSelection && <div className="ml-auto flex items-center gap-0.5 rounded-lg border border-[#302e29] bg-[#11110f] p-1 soft-in" data-testid="toolbar-formatting">
            <FormatButton label="Bold" icon={<Bold size={15} />} action={() => applyFormat('bold')} id="button-format-bold" />
            <FormatButton label="Italic" icon={<Italic size={15} />} action={() => applyFormat('italic')} id="button-format-italic" />
            <FormatButton label="Underline" icon={<Underline size={15} />} action={() => applyFormat('underline')} id="button-format-underline" />
          </div>}
          {imageSelected && <div className="ml-auto flex items-center gap-1 rounded-lg border border-[#302e29] bg-[#11110f] p-1 soft-in" data-testid="toolbar-image">
            <span className="px-2 text-[11px] text-[#77736c]">Image</span>
            <button onMouseDown={event => event.preventDefault()} onClick={removeSelectedImage} className="control-focus rounded-md px-2.5 py-1.5 text-xs text-[#c39a8a] hover:bg-[#251a17]" data-testid="button-remove-image">Remove</button>
          </div>}
        </div>
        <div
          ref={bodyRef}
          className="note-body min-h-[42vh] font-[var(--editor-font)] text-[#cfc9bf] caret-[#d1bd98] selection:bg-[#594d37]"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label="Write your page"
          aria-multiline="true"
          data-placeholder={props.note.kind === 'journal' ? 'Begin with what stayed with you…' : props.note.kind === 'task' ? 'What needs doing?' : props.note.kind === 'checklist' ? 'Add a thought, then make a list…' : 'Begin anywhere…'}
          style={{ fontFamily: props.settings.fontFamily === 'Georgia' ? 'Georgia, serif' : "'Literata', Georgia, serif", fontSize: `${props.settings.fontSize}px`, lineHeight: props.settings.lineSpacing }}
          onInput={handleBody}
          onClick={event => {
            const target = event.target;
            if (target instanceof HTMLImageElement) {
              selectedImageRef.current = target;
              setImageSelected(true);
              setHasSelection(false);
            }
          }}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (timerRef.current) clearTimeout(timerRef.current);
              flushSave(title, bodyRef.current?.innerHTML ?? body);
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

function SettingsScreen(props: {
  settings: QuietSettings;
  onChange: (settings: QuietSettings) => void;
  onBack: () => void;
}) {
  const update = (partial: Partial<QuietSettings>) => props.onChange({ ...props.settings, ...partial });
  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-[720px] px-6 pb-20 pt-6 sm:px-10 sm:pt-9" data-testid="screen-settings">
      <header className="flex items-center">
        <button onClick={props.onBack} className="control-focus flex items-center gap-2 rounded-full px-2 py-2 text-sm text-[#89847b] hover:text-[#e4dccf]" data-testid="button-settings-back"><ArrowLeft size={17} strokeWidth={1.6} /><span>Back</span></button>
      </header>
      <div className="mt-[clamp(3rem,12vh,7rem)]">
        <p className="mb-3 text-[10px] uppercase tracking-[.22em] text-[#6b665d]">Your space</p>
        <h1 className="m-0 font-[var(--app-font-serif)] text-4xl font-normal tracking-[-.03em] text-[#e1dbcf]">Writing, your way.</h1>
        <p className="mt-3 max-w-md font-[var(--app-font-serif)] text-base leading-relaxed text-[#777168]">A few quiet choices for how your words sit on the page.</p>
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
            <span className="font-[var(--app-font-serif)] text-sm text-[#827c71]">A</span>
            <input type="range" min="16" max="30" step="1" value={props.settings.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} className="w-40 accent-[#b6a27e]" aria-label="Writing font size" data-testid="input-font-size" />
            <span className="font-[var(--app-font-serif)] text-2xl text-[#cfc5b1]">A</span>
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
