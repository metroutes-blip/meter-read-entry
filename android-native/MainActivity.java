package com.metroutes.lvb;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

// Copied over Capacitor's generated MainActivity by the Android build (see .github/workflows/android.yml),
// so LVB's own plugins are registered.
public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(LvbEmailPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
