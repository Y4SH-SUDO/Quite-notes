package com.quietnotes.app;

import android.view.View;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ImmersiveReader")
public class ImmersiveReaderPlugin extends Plugin {
    private Integer originalSystemUiVisibility;

    @PluginMethod
    public void enter(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            View decorView = getActivity().getWindow().getDecorView();
            if (originalSystemUiVisibility == null) {
                originalSystemUiVisibility = decorView.getSystemUiVisibility();
            }
            int immersiveFlags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            decorView.setSystemUiVisibility(immersiveFlags);
            call.resolve();
        });
    }

    @PluginMethod
    public void exit(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            View decorView = getActivity().getWindow().getDecorView();
            if (originalSystemUiVisibility != null) {
                decorView.setSystemUiVisibility(originalSystemUiVisibility);
                originalSystemUiVisibility = null;
            } else {
                decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            }
            call.resolve();
        });
    }
}
