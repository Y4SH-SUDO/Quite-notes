# Quiet Notes for Android

## Backup format

Quiet Notes exports UTF-8 JSON with `app: "quiet-notes"` and `schemaVersion: 1`.
The backup contains the export timestamp, notes, writing preferences, and derived tags.
Note content remains HTML; embedded images remain inline `data:image/...` URLs, so the
image bytes travel with the note. Note IDs, note kinds, timestamps, task schedules,
pin/favorite values, and saved image attributes (including `data-wrap`) are retained.
Older notes without pin or favorite values remain valid and are treated as unpinned
and not favorited.

Restore validates the complete JSON before showing an import preview. Merge imports
only new note IDs and leaves existing records untouched; the alternative skips the
whole backup if any ID already exists. Neither choice replaces or deletes existing
notes. On Android, export writes a temporary JSON file in app cache and opens the
system share sheet; choose a destination there to keep a portable copy.

## Android release and in-place update

The application ID is `com.quietnotes.app`. Version 1.1 uses version code 2. Local
notes remain in the existing IndexedDB database (`quiet-notes-local`, schema version
1); no database reset or schema migration is performed. Pin/favorite fields are
optional on old records. Firebase authentication and note synchronization continue to
use the existing Firebase project and conflict handling.

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
