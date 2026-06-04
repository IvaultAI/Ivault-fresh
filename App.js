import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, StatusBar, ActivityIndicator, Platform, KeyboardAvoidingView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import {
  useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync,
} from 'expo-audio';
// Legacy FileSystem API (uploadAsync moved to /legacy in SDK 54+). We use the
// BINARY_CONTENT upload type to stream the recorded file's raw bytes as the
// request body — see transcribe() for why raw-binary, not multipart.
import * as FileSystem from 'expo-file-system/legacy';

const API = 'https://api.ivaultai.com';
const TOKEN_KEY = 'token';

// Deepgram STT. Key sourced from /opt/ivault/secrets/deepgram.json at build
// time. NOTE: this is embedded in the client bundle and is therefore
// extractable from a shipped build. For production, proxy STT through
// api.ivaultai.com instead of calling Deepgram directly from the device.
const DG_KEY = '6fe38507dc54907270eace8d9c6db93b6d5bed40';
const DG_LISTEN =
  'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true';

// Palette mirrors the iVault web portal (app/agent_mike.html).
const C = {
  bg: '#0a0a0a',
  accent: '#00ff88',
  rec: '#ff3b5c',
  text: '#e8eefc',
  muted: 'rgba(232,238,252,0.55)',
};

// Foreground notifications surface as a banner (SDK 56 handler shape).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Upload the recorded audio file to Deepgram and return the transcript.
//
// IMPORTANT: Deepgram's pre-recorded /v1/listen endpoint expects the RAW audio
// bytes as the request body with an audio Content-Type — it does NOT accept
// multipart/form-data (a multipart envelope is rejected with "corrupt or
// unsupported data", verified against the live API on 2026-06-04). It also does
// not accept base64 or an in-memory Blob (both were tried in earlier builds and
// failed). The correct React Native pattern is therefore FileSystem.uploadAsync
// with BINARY_CONTENT, which streams the file at `uri` as the raw request body.
async function transcribe(uri) {
  const res = await FileSystem.uploadAsync(DG_LISTEN, uri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      Authorization: `Token ${DG_KEY}`,
      'Content-Type': 'audio/m4a', // RecordingPresets.HIGH_QUALITY → .m4a (AAC)
    },
  });
  if (res.status !== 200) {
    console.log('[dg] non-200:', res.status, (res.body || '').slice(0, 200));
    return '';
  }
  try {
    const data = JSON.parse(res.body);
    return (
      data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || ''
    ).trim();
  } catch (e) {
    console.log('[dg] parse error:', e?.message || e);
    return '';
  }
}

// Register for push + POST the Expo token to /agent/register-push.
// The route (db.push_registrations) accepts device_token|push_token|native_token|expo_token.
async function registerPush(agentToken) {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Default',
        importance: Notifications.AndroidImportance.MAX,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') {
      console.log('[push] permission not granted:', status);
      return null;
    }

    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const pushToken = tokenData.data;

    const r = await fetch(`${API}/agent/register-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: agentToken,
        expo_token: pushToken,
        push_token: pushToken,
        device_token: pushToken,
        platform: Platform.OS,
      }),
    });
    console.log('[push] register-push status:', r.status);
    return pushToken;
  } catch (e) {
    console.log('[push] registration error:', e?.message || e);
    return null;
  }
}

export default function App() {
  const [token, setToken] = useState('');     // value in the entry field
  const [saved, setSaved] = useState(null);    // the persisted token (null = none)
  const [booting, setBooting] = useState(true); // reading SecureStore on launch
  const pushDone = useRef(false);
  const webRef = useRef(null);

  // expo-audio recorder (SDK 56). The hook owns the recorder instance; its
  // .uri is populated after stop().
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  // On launch, restore any previously saved token.
  useEffect(() => {
    (async () => {
      try {
        const t = await SecureStore.getItemAsync(TOKEN_KEY);
        if (t) setSaved(t);
      } catch (e) {
        console.log('[secure-store] read error:', e?.message || e);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  // On app load: request mic permission and put the audio session into a mode
  // that allows recording (per the SDK 56 expo-audio pattern).
  useEffect(() => {
    (async () => {
      try {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          console.log('[mic] recording permission not granted');
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      } catch (e) {
        console.log('[mic] audio setup error:', e?.message || e);
      }
    })();
  }, []);

  // Push registration is triggered after the WebView finishes loading
  // (see onLoadEnd below), so the permission prompt appears once the portal
  // is on screen rather than during the boot/token handshake. Runs once.
  const onWebViewLoaded = useCallback(() => {
    if (saved && !pushDone.current) {
      pushDone.current = true;
      registerPush(saved);
    }
  }, [saved]);

  const save = useCallback(async () => {
    const t = token.trim();
    if (!t) return;
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, t);
    } catch (e) {
      console.log('[secure-store] write error:', e?.message || e);
    }
    setSaved(t);
  }, [token]);

  // Deliver a transcript into the portal's chat composer and send it. The
  // portal (app/agent.html) exposes #chatInput and a global sendChat().
  const injectTranscript = useCallback((text) => {
    if (!text) return;
    const js = `(function(){try{
      var t = ${JSON.stringify(text)};
      var ta = document.getElementById('chatInput');
      if (ta) { ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      if (typeof sendChat === 'function') { sendChat(); }
    } catch (e) {} })(); true;`;
    webRef.current?.injectJavaScript(js);
  }, []);

  // Mic button: tap to start, tap again to stop → transcribe → inject.
  const startRec = useCallback(async () => {
    try {
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      setRecording(true);
    } catch (e) {
      console.log('[mic] start error:', e?.message || e);
      setRecording(false);
    }
  }, [audioRecorder]);

  const stopRec = useCallback(async () => {
    setRecording(false);
    setTranscribing(true);
    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      if (!uri) {
        console.log('[mic] no recording uri');
        return;
      }
      const transcript = await transcribe(uri);
      if (transcript) injectTranscript(transcript);
      else console.log('[mic] empty transcript');
    } catch (e) {
      console.log('[mic] stop/transcribe error:', e?.message || e);
    } finally {
      setTranscribing(false);
    }
  }, [audioRecorder, injectTranscript]);

  const onMicPress = useCallback(() => {
    if (transcribing) return;       // ignore taps while uploading
    if (recording) stopRec();
    else startRec();
  }, [recording, transcribing, startRec, stopRec]);

  // Boot splash while SecureStore resolves.
  if (booting) {
    return (
      <SafeAreaView style={s.center}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <ActivityIndicator color={C.accent} size="large" />
      </SafeAreaView>
    );
  }

  // Native token-entry screen.
  if (!saved) {
    return (
      <SafeAreaView style={s.center}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <KeyboardAvoidingView
          style={s.entryInner}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Text style={s.logo}>iVault AI</Text>
          <Text style={s.sub}>YOUR AI ASSISTANT</Text>
          <TextInput
            style={s.input}
            placeholder="Paste your token"
            placeholderTextColor="#666"
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={false}
            onSubmitEditing={save}
            returnKeyType="go"
          />
          <TouchableOpacity style={s.btn} onPress={save} activeOpacity={0.85}>
            <Text style={s.btnText}>Connect</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // WebView shell: load the agent portal with the saved token.
  const uri = `${API}/agent?token=${encodeURIComponent(saved)}`;
  return (
    <SafeAreaView style={s.flex}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <WebView
        ref={webRef}
        source={{ uri }}
        style={s.flex}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback={true}
        mediaCapturePermissionGrantType="grant"
        onPermissionRequest={(request) => request.grant(request.resources)}
        originWhitelist={['*']}
        startInLoadingState
        onLoadEnd={onWebViewLoaded}
        renderLoading={() => (
          <View style={s.loading}>
            <ActivityIndicator color={C.accent} size="large" />
          </View>
        )}
      />

      {/* Native mic FAB — records via expo-audio, transcribes via Deepgram,
          then injects the text into the portal's chat. This replaces the
          unreliable in-WebView getUserMedia mic on standalone Android. */}
      <TouchableOpacity
        style={[s.mic, recording && s.micRec]}
        onPress={onMicPress}
        activeOpacity={0.85}
        accessibilityLabel={recording ? 'Stop recording' : 'Start voice message'}
      >
        {transcribing ? (
          <ActivityIndicator color="#000" />
        ) : (
          <Text style={s.micIcon}>{recording ? '■' : '🎤'}</Text>
        )}
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center', padding: 24 },
  entryInner: { width: '100%', maxWidth: 420 },

  logo: { color: C.accent, fontSize: 32, fontWeight: '700', textAlign: 'center', letterSpacing: 0.5 },
  sub: { color: C.accent, fontSize: 11, fontWeight: '600', letterSpacing: 4.5, textTransform: 'uppercase', textAlign: 'center', marginTop: 6, marginBottom: 28, opacity: 0.85 },

  input: { borderWidth: 1, borderColor: '#333', color: '#fff', padding: 14, borderRadius: 10, marginBottom: 14, fontSize: 16 },
  btn: { backgroundColor: C.accent, padding: 15, borderRadius: 10, alignItems: 'center' },
  btnText: { color: '#000', fontWeight: 'bold', fontSize: 16 },

  loading: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center',
  },

  mic: {
    position: 'absolute', right: 18, bottom: 96,
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: C.accent, justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  micRec: { backgroundColor: C.rec },
  micIcon: { fontSize: 24, color: '#000' },
});
