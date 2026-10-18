# Quiet Notes for Android

## Backup format

Quiet Notes exports UTF-8 JSON with `app: "quiet-notes"`. Note-only backups use
`schemaVersion: 1`; backups that contain reading-library metadata or handwritten
vector strokes use `schemaVersion: 2`. The importer continues to accept existing
version-1 files. Backups contain the export timestamp, notes, writing preferences,
and derived tags.
Note content remains HTML; embedded images remain inline `data:image/...` URLs, so the
image bytes travel with the note. Note IDs, note kinds, timestamps, task schedules,
pin/favorite values, and saved image attributes (including `data-wrap`) are retained.
Older notes without pin or favorite values remain valid and are treated as unpinned
and not favorited.

Reading-library backups include document titles, format, reading position, bookmarks,
highlights, and attached thoughts. They do not include imported PDF, EPUB, or text file
binaries; after restoring such a backup, re-import the original document to continue
reading. Bookmark names can be edited without changing their saved reading locations.
PDF highlights are anchored to selectable text on a page; EPUB highlights use EPUB CFI
locations. Android full-screen reading hides the system bars through the native
Capacitor bridge, with an in-reader control to reveal controls or exit. Handwriting is
saved as vector stroke data on its note and is included in backup version 2.

Restore validates the complete JSON before showing an import preview. Merge imports
only new note IDs and leaves existing records untouched; the alternative skips the
whole backup if any ID already exists. Neither choice replaces or deletes existing
notes. On Android, export writes a temporary JSON file in app cache and opens the
system share sheet; choose a destination there to keep a portable copy.

On Android, **Settings → Data & Backup** can also select a phone folder for the
rolling `quiet-notes-backup.json` file. A successful local save marks the snapshot
pending and writes the complete current backup after a short debounce. The app
validates a temporary file and reads it back before replacing the previous backup.
Some Android folder providers do not support the required safe rename operations;
in that case the previous file is kept and the failure is shown in Settings. This is
an offline copy, not Google Drive. It protects against many app-data failures but
cannot recover edits made after the last successful backup or protect against loss or
physical destruction of the phone.

Imported documents are stored locally in the existing IndexedDB database and are
limited to 50 MB each. PDF text highlighting depends on a selectable text layer;
scanned pages can still be read and bookmarked but are not OCR'd or highlightable.
Finger drawing on the handwriting canvas is off by default; pen pressure is used
when exposed by the Android WebView, with a fallback otherwise. Browser pointer
events do not provide Samsung Notes-level palm rejection.

## Android release and in-place update

The application ID is `com.quietnotes.app`. Version 1.1 uses version code 2. Local
notes remain in the existing IndexedDB database (`quiet-notes-local`). The additive
version-2 upgrade creates a separate reading-library store; it does not clear or
rewrite existing notes, settings, or Firebase data. Existing note records and optional
pin/favorite fields remain backward-compatible. Firebase authentication and note
synchronization continue to use the existing Firebase project and conflict handling.

Before installing an update, export a backup and verify that it can be selected and
validated by the import preview. Keep the original Version 1 APK. The release build
must be signed with the same signing identity as the installed APK. Gradle reads the
existing signing configuration from `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`; do not generate a replacement key.
If any of these values are absent, Gradle does not configure release signing; do not
install an unsigned release APK as an update.
Compare the SHA-256 signer certificate fingerprints from both APKs with `apksigner
verify --print-certs` before attempting an update. If they differ or the original
signing identity cannot be verified, do not install the update over the existing app.

With the matching signer verified, install without uninstalling Version 1:

```sh
adb install -r quiet-notes-1.1.apk
```

After installation, open the app and inspect existing notes, images, preferences,
authentication, and sync status before relying on the new build. If anything is
missing, do not clear app data or uninstall; use **Settings → Data & Backup** to
merge the verified backup into the current installation. In-place upgrade and
rollback behavior must be checked on the actual target device before release.

## Build

The Vite configuration requires `PORT` and `BASE_PATH`. A local web build can be
created with:

```sh
PORT=4173 BASE_PATH=/ pnpm --filter @workspace/quiet-notes build
pnpm --filter @workspace/quiet-notes android:sync
```

After the original and release APK signer fingerprints have been verified, build the
release APK from `artifacts/quiet-notes/android` with `./gradlew :app:assembleRelease`.
