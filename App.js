import { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  SafeAreaView, StatusBar, ActivityIndicator, Platform, KeyboardAvoidingView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

const API = 'https://api.ivaultai.com';
const TOKEN_KEY = 'token';

// Palette mirrors the iVault web portal (app/agent_mike.html).
const C = {
  bg: '#0a0a0a',
  accent: '#00ff88',
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

  // Once a token is set, register for push exactly once.
  useEffect(() => {
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
        source={{ uri }}
        style={s.flex}
        javaScriptEnabled
        domStorageEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        originWhitelist={['*']}
        startInLoadingState
        renderLoading={() => (
          <View style={s.loading}>
            <ActivityIndicator color={C.accent} size="large" />
          </View>
        )}
      />
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
});
