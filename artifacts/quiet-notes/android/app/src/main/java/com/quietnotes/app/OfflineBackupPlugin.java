package com.quietnotes.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import androidx.activity.result.ActivityResult;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "OfflineBackup")
public class OfflineBackupPlugin extends Plugin {
    private static final String PREFS = "quiet-notes-offline-backup";
    private static final String TREE_URI = "tree-uri";
    private static final String BACKUP_NAME = "quiet-notes-backup.json";
    private static final int MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void selectFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
        );
        startActivityForResult(call, intent, "folderSelected");
    }

    @PluginMethod
    public void selectDocument(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
            "application/pdf",
            "application/epub+zip",
            "text/plain",
            "text/markdown",
            "text/x-markdown",
            "application/x-markdown"
        });
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "documentSelected");
    }

    @ActivityCallback
    private void documentSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject response = new JSObject();
            response.put("canceled", true);
            call.resolve(response);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("Android did not return a document.");
            return;
        }
        try {
            int grants = result.getData().getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION;
            if (grants != 0) getContext().getContentResolver().takePersistableUriPermission(uri, grants);
        } catch (SecurityException error) {
            call.reject("Android did not grant access to the selected document.", error);
            return;
        }
        io.execute(() -> {
            try {
                String name = documentName(uri);
                String mimeType = getContext().getContentResolver().getType(uri);
                byte[] bytes = readDocument(uri);
                JSObject response = new JSObject();
                response.put("name", name);
                response.put("mimeType", mimeType == null ? "application/octet-stream" : mimeType);
                response.put("size", bytes.length);
                response.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "The selected document could not be read." : error.getMessage(), error);
            } finally {
                releaseDocumentPermission(uri);
            }
        });
    }

    @ActivityCallback
    private void folderSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            JSObject response = new JSObject();
            response.put("canceled", true);
            call.resolve(response);
            return;
        }
        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("Android did not return a folder location.");
            return;
        }
        int grants = result.getData().getFlags()
            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            getContext().getContentResolver().takePersistableUriPermission(treeUri, grants);
            getPreferences().edit().putString(TREE_URI, treeUri.toString()).apply();
            call.resolve(folderResult(treeUri));
        } catch (Exception error) {
            call.reject("The selected folder permission could not be saved.", error);
        }
    }

    @PluginMethod
    public void getFolder(PluginCall call) {
        String saved = getPreferences().getString(TREE_URI, null);
        if (saved == null) {
            call.resolve(new JSObject());
            return;
        }
        Uri treeUri = Uri.parse(saved);
        if (!hasPersistedPermission(treeUri)) {
            getPreferences().edit().remove(TREE_URI).apply();
            call.resolve(new JSObject());
            return;
        }
        try {
            call.resolve(folderResult(treeUri));
        } catch (Exception error) {
            call.reject("The configured backup folder is no longer available.", error);
        }
    }

    @PluginMethod
    public void writeBackup(PluginCall call) {
        String content = call.getString("content");
        String saved = getPreferences().getString(TREE_URI, null);
        if (content == null || saved == null) {
            call.reject(saved == null ? "Choose a backup folder first." : "Backup content is missing.");
            return;
        }
        Uri treeUri = Uri.parse(saved);
        if (!hasPersistedPermission(treeUri)) {
            getPreferences().edit().remove(TREE_URI).apply();
            call.reject("Access to the backup folder was revoked. Choose the folder again.");
            return;
        }
        io.execute(() -> {
            try {
                Uri savedFile = writeValidatedBackup(treeUri, content);
                JSObject response = new JSObject();
                response.put("name", BACKUP_NAME);
                response.put("uri", savedFile.toString());
                response.put("writtenAt", System.currentTimeMillis());
                call.resolve(response);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "The backup could not be safely replaced." : error.getMessage(), error);
            }
        });
    }

    private Uri writeValidatedBackup(Uri treeUri, String content) throws Exception {
        validateBackup(content);
        Uri parent = DocumentsContract.buildDocumentUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri)
        );
        String suffix = UUID.randomUUID().toString();
        String tempName = ".quiet-notes-backup-" + suffix + ".tmp";
        String rollbackName = ".quiet-notes-backup-" + suffix + ".previous";
        Uri temp = DocumentsContract.createDocument(
            getContext().getContentResolver(),
            parent,
            "application/json",
            tempName
        );
        if (temp == null) throw new IllegalStateException("The selected folder could not create a temporary backup.");

        Uri previous = null;
        Uri designated = null;
        boolean oldMoved = false;
        boolean newMoved = false;
        try {
            writeAndVerify(temp, content);
            designated = findChild(treeUri, BACKUP_NAME);
            if (designated != null) {
                previous = DocumentsContract.renameDocument(
                    getContext().getContentResolver(),
                    designated,
                    rollbackName
                );
                if (previous == null) {
                    throw new IllegalStateException("This folder provider cannot safely preserve the previous backup while replacing it.");
                }
                oldMoved = true;
            }
            Uri replacement = DocumentsContract.renameDocument(
                getContext().getContentResolver(),
                temp,
                BACKUP_NAME
            );
            if (replacement == null) {
                throw new IllegalStateException("This folder provider cannot safely rename the validated backup into place.");
            }
            newMoved = true;
            writeAndVerify(replacement, content);
            if (oldMoved && !DocumentsContract.deleteDocument(getContext().getContentResolver(), previous)) {
                throw new IllegalStateException("The new backup is valid, but the previous temporary copy could not be removed.");
            }
            return replacement;
        } catch (Exception error) {
            Exception cleanupFailure = null;
            try {
                if (newMoved) {
                    Uri failedReplacement = findChild(treeUri, BACKUP_NAME);
                    if (failedReplacement != null && !DocumentsContract.deleteDocument(getContext().getContentResolver(), failedReplacement)) {
                        cleanupFailure = new IllegalStateException("The incomplete replacement could not be removed.");
                    }
                } else if (!DocumentsContract.deleteDocument(getContext().getContentResolver(), temp)) {
                    cleanupFailure = new IllegalStateException("The temporary backup could not be removed.");
                }
            } catch (Exception cleanupError) {
                cleanupFailure = cleanupError;
            }
            if (cleanupFailure != null) error.addSuppressed(cleanupFailure);
            if (oldMoved && previous != null) {
                try {
                    restorePrevious(previous);
                } catch (Exception restoreError) {
                    throw new IllegalStateException(
                        "Backup replacement failed and the previous file could not be restored automatically. Its contents remain in the selected folder as " + rollbackName + ".",
                        restoreError
                    );
                }
            }
            throw error;
        }
    }

    private void restorePrevious(Uri previous) throws Exception {
        if (DocumentsContract.renameDocument(
            getContext().getContentResolver(),
            previous,
            BACKUP_NAME
        ) == null) {
            throw new IllegalStateException("The previous backup could not be restored to its original name.");
        }
    }

    private void writeAndVerify(Uri uri, String content) throws Exception {
        try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (output == null) throw new IllegalStateException("The selected folder did not open the backup for writing.");
            output.write(content.getBytes(StandardCharsets.UTF_8));
            output.flush();
        }
        String readBack = readText(uri);
        if (!content.equals(readBack)) throw new IllegalStateException("The written backup did not match the complete snapshot.");
        validateBackup(readBack);
    }

    private String readText(Uri uri) throws Exception {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IllegalStateException("The backup could not be read back from the selected folder.");
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void validateBackup(String json) throws Exception {
        JSONObject backup = new JSONObject(json);
        if (!"quiet-notes".equals(backup.optString("app"))
            || (backup.optInt("schemaVersion") != 1 && backup.optInt("schemaVersion") != 2)
            || !(backup.opt("notes") instanceof JSONArray)
            || !(backup.opt("settings") instanceof JSONObject)
            || !(backup.opt("tags") instanceof JSONArray)
            || (backup.optInt("schemaVersion") == 2 && !(backup.opt("library") instanceof JSONArray))) {
            throw new IllegalArgumentException("The backup snapshot is not a complete supported Quiet Notes backup.");
        }
    }

    private String documentName(Uri uri) throws Exception {
        try (Cursor cursor = getContext().getContentResolver().query(
            uri,
            new String[] { OpenableColumns.DISPLAY_NAME },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        }
        throw new IllegalStateException("The selected document does not have a readable file name.");
    }

    private byte[] readDocument(Uri uri) throws Exception {
        try (InputStream input = getContext().getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) throw new IllegalStateException("The selected document could not be opened.");
            byte[] buffer = new byte[32 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > MAX_DOCUMENT_BYTES) {
                    throw new IllegalStateException("Documents larger than 50 MB cannot be imported yet.");
                }
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }

    private void releaseDocumentPermission(Uri uri) {
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (uri.equals(permission.getUri()) && permission.isReadPermission()) {
                try {
                    getContext().getContentResolver().releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (SecurityException error) {
                    android.util.Log.w("OfflineBackup", "Could not release the temporary document permission.", error);
                }
                return;
            }
        }
    }

    private Uri findChild(Uri treeUri, String name) throws Exception {
        String parentId = DocumentsContract.getTreeDocumentId(treeUri);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentId);
        try (Cursor cursor = getContext().getContentResolver().query(
            children,
            new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID, OpenableColumns.DISPLAY_NAME },
            null,
            null,
            null
        )) {
            if (cursor == null) throw new IllegalStateException("The selected folder could not be listed.");
            int idColumn = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
            while (cursor.moveToNext()) {
                if (nameColumn >= 0 && name.equals(cursor.getString(nameColumn))) {
                    return DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(idColumn));
                }
            }
        }
        return null;
    }

    private JSObject folderResult(Uri treeUri) {
        JSObject result = new JSObject();
        result.put("uri", treeUri.toString());
        result.put("name", folderName(treeUri));
        return result;
    }

    private String folderName(Uri treeUri) {
        Uri document = DocumentsContract.buildDocumentUriUsingTree(
            treeUri,
            DocumentsContract.getTreeDocumentId(treeUri)
        );
        try (Cursor cursor = getContext().getContentResolver().query(
            document,
            new String[] { OpenableColumns.DISPLAY_NAME },
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception error) {
            android.util.Log.w("OfflineBackup", "Could not read the selected backup-folder name.", error);
        }
        return "Selected folder";
    }

    private boolean hasPersistedPermission(Uri treeUri) {
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (treeUri.equals(permission.getUri()) && permission.isReadPermission() && permission.isWritePermission()) return true;
        }
        return false;
    }

    private SharedPreferences getPreferences() {
        return getContext().getSharedPreferences(PREFS, 0);
    }
}
