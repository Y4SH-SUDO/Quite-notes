# Quiet Notes

Quiet Notes is a local-first notes app. The React/Vite app keeps notes in IndexedDB, supports JSON export/import, and can be packaged for Android with Capacitor.

## Firebase setup for cloud sync

Cloud sync is opt-in and requires a Firebase project. The app does not contain service-account credentials. Its Firebase web configuration is public client configuration; access control is enforced by Firebase Authentication and the rules in `firestore.rules` and `storage.rules`.

1. In Firebase Console, create a project and register a Web app. Find the client values in **Project settings** (gear) → **General** → **Your apps** → select the Web app → **SDK setup and configuration** → **Config**. Do not use service-account credentials.
2. In **Authentication → Sign-in method**, enable **Email/Password**.
3. Create a Cloud Firestore database and publish `firestore.rules` from this repository in the Firestore Rules tab.
4. For local development, put the required Firebase Web app config into `artifacts/quiet-notes/.env.local`, using the exact variable names in `artifacts/quiet-notes/.env.example`; restart the dev server or rebuild after changing them. `.env.local` is ignored by Git and must never be committed.
5. For APK builds, set the required `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` values under **GitHub repository → Settings → Secrets and variables → Actions → Variables**. These are Firebase Web app client configuration values, not admin credentials. `VITE_FIREBASE_STORAGE_BUCKET` is optional; without it, text and task sync still work and embedded images remain local to their original device. Do not add service-account JSON or private keys to GitHub Actions variables or source control.

If you choose to enable cross-device image sharing, create a Storage bucket, publish `storage.rules` in the Storage Rules tab, and set `VITE_FIREBASE_STORAGE_BUCKET`. Firebase Storage may require a paid billing plan; it is optional and not required for authentication or Firestore text/task sync.

The app's sync path is `/users/{Firebase Auth UID}/notes/{note ID}`. Sync compares the last shared update timestamp and surfaces concurrent edits for an explicit choice. Image sharing is optional and uses Firebase Storage only when a bucket is configured and the service permits access; failed image transfers do not prevent text/task sync, and local images are never removed. Offline edits stay in IndexedDB and are retried when the app becomes online, focused, or the periodic sync runs. Verify Firestore rules and cross-account isolation in a configured Firebase project before using this for important data.

## Android APK from GitHub Codespaces

The Android application ID is **`com.quietnotes.app`**. Treat it as permanent once installed; changing it creates a separate Android app.

1. Open the repository in Codespaces from your Android browser. In the terminal run:

   ```sh
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm --dir artifacts/quiet-notes typecheck
   pnpm --dir artifacts/quiet-notes test:backup
   ```

2. Ensure the project changes and `.github/workflows/android-apk.yml` are committed and pushed to the repository's default branch. GitHub cannot run a workflow file that exists only in an uncommitted Codespaces worktree. Review the Source Control changes first; `.env.local` is ignored and must not be staged.
3. In GitHub, open **Actions → Android APK → Run workflow**, select the default branch, and start the run. The same workflow also builds automatically when relevant files are pushed to `main`.
4. Wait for the run to finish successfully. Open that run and download the `quiet-notes-debug-apk` artifact (or `quiet-notes-release-apk` if signing secrets were configured). The artifact is a ZIP containing the APK.
5. On Android, open the ZIP in Downloads, extract it if prompted, tap the APK, and allow the browser or Files app to install apps from that source when Android asks. Install the same APK on both devices.
6. Open Quiet Notes → **Settings → Cloud sync**, create/sign into the same Firebase account, and resolve any first-sync ID conflicts deliberately. If only the core Firebase variables are configured, text and tasks sync while embedded images remain on their original device.

The Codespace does not need Android Studio or a local Android SDK: GitHub Actions installs the SDK and builds the APK. The workflow initially produces a **debug APK**. A release APK requires the same signing key on every build; configure the GitHub Actions secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` to enable it. Keep a secure backup of that keystore. Never commit or paste its password/key into source files or chat.

## Updates and data safety

Installing a newer APK signed with the same key and using the same application ID updates the existing installation. A debug APK from a different build runner may have a different debug signing key and may not update in place. If Android requires uninstalling an incompatible debug build, local-only IndexedDB data may be removed. Before uninstalling, export a backup; after installing, sign into the same Firebase account to download synced notes. Do not rely on cloud sync until it has been configured and tested with your project.

## Reminder limitations

The Android app uses Capacitor local notifications, which can alert while Quiet Notes is closed after permission is granted. Exact timing is subject to Android alarm permissions and Xiaomi battery/background restrictions. Browser notifications use a foreground-page timer and an active notification service worker to display the alert; reminders are not scheduled for delivery after the browser/tab is closed. Cross-platform remote push delivery while desktop browsers are closed is not implemented yet.

In **Settings → Task reminders**, first enable notification permission, then use **Send test notification** to inspect the current browser origin, secure-context status, permission, service-worker registration/readiness, `showNotification()` result, and any exact errors. Codespaces `app.github.dev` URLs use HTTPS and are eligible secure contexts, but the browser, device, permission policy, and notification settings can still prevent delivery; use the in-app test on the device/browser that will receive alerts. Do not treat scheduled timers as proof that the operating system displayed a notification.
