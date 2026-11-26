package com.metroutes.lvb;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.ArrayList;

// Opens a new email with To, Cc, subject, text and attachments filled in.
// The files are already saved in the app's cache; only their paths come from the web side, so the
// request stays small. It goes straight to Gmail (the tablets' mail app, allowed in the kiosk),
// without Android's app picker, which a locked tablet may block. The app picker is used only when
// Gmail isn't there. The call returns once the mail app has been started, not when it is closed.
@CapacitorPlugin(name = "LvbEmail")
public class LvbEmailPlugin extends Plugin {
  private static final String GMAIL = "com.google.android.gm";

  @PluginMethod
  public void open(PluginCall call) {
    try {
      Context ctx = getContext();
      String authority = ctx.getPackageName() + ".fileprovider";
      ArrayList<Uri> uris = new ArrayList<>();
      JSArray paths = call.getArray("paths", new JSArray());
      for (int i = 0; i < paths.length(); i++) {
        File file = new File(paths.getString(i));
        if (!file.exists()) {
          call.reject("Missing file: " + file.getName());
          return;
        }
        uris.add(FileProvider.getUriForFile(ctx, authority, file));
      }

      Intent intent = new Intent(uris.size() > 1 ? Intent.ACTION_SEND_MULTIPLE : Intent.ACTION_SEND);
      intent.setType(uris.isEmpty() ? "message/rfc822" : "*/*");
      intent.putExtra(Intent.EXTRA_EMAIL, strings(call.getArray("to", new JSArray())));
      intent.putExtra(Intent.EXTRA_CC, strings(call.getArray("cc", new JSArray())));
      intent.putExtra(Intent.EXTRA_SUBJECT, call.getString("subject", ""));
      intent.putExtra(Intent.EXTRA_TEXT, call.getString("body", ""));
      if (uris.size() == 1) intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
      if (uris.size() > 1) intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
      // Let the mail app read the files.
      ClipData clip = null;
      for (Uri uri : uris) {
        if (clip == null) clip = ClipData.newRawUri("", uri);
        else clip.addItem(new ClipData.Item(uri));
      }
      if (clip != null) intent.setClipData(clip);
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

      Intent gmail = new Intent(intent).setPackage(GMAIL);
      getActivity().runOnUiThread(() -> {
        try {
          try {
            getActivity().startActivity(gmail);
          } catch (ActivityNotFoundException noGmail) {
            getActivity().startActivity(Intent.createChooser(intent, "Send email"));
          }
          call.resolve();
        } catch (Exception e) {
          call.reject(e.getLocalizedMessage(), e);
        }
      });
    } catch (Exception e) {
      call.reject(e.getLocalizedMessage(), e);
    }
  }

  private static String[] strings(JSArray arr) throws Exception {
    String[] out = new String[arr.length()];
    for (int i = 0; i < arr.length(); i++) out[i] = arr.getString(i);
    return out;
  }
}
