import { useState, useRef, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, SafeAreaView, StatusBar, Animated, Easing } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useAudioRecorder, RecordingPresets, AudioModule, setAudioModeAsync, createAudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

const API = 'https://api.ivaultai.com';

// Deepgram key sourced from /opt/ivault/secrets/deepgram.json at build time.
// NOTE: this is embedded in the client bundle and is therefore extractable from
// a shipped build. For production, proxy STT/TTS through api.ivaultai.com instead.
const DEEPGRAM_KEY = '6fe38507dc54907270eace8d9c6db93b6d5bed40';
const DG_LISTEN = 'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true';
const DG_SPEAK = 'https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mp3&bit_rate=48000';

// Palette mirrors the iVault web portal (app/agent_mike.html).
const C = {
  bg: '#0a0a0a',        // dark theme background (per spec)
  accent: '#00ff88',    // green accent / logo / talk button
  orb1: '#bfe0ff',      // orb highlight
  orb2: '#1e90ff',      // orb mid (portal --accent blue)
  orb3: '#0b3a78',      // orb deep
  text: '#e8eefc',
  muted: 'rgba(232,238,252,0.55)',
  panel: '#111729',
  danger: '#e2574c',
};

// --- Pulsing blue orb (idle animation), matching the web portal's @pulse-idle ---
function Orb({ active }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const dur = active ? 680 : 3400; // .68s active vs 3.4s idle, per portal CSS
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: dur / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: dur / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    const ringLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(ring, { toValue: 1, duration: dur / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(ring, { toValue: 0, duration: dur / 2, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    loop.start();
    ringLoop.start();
    return () => { loop.stop(); ringLoop.stop(); };
  }, [active]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, active ? 1.17 : 1.07] });
  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, active ? 1.34 : 1.18] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 1], outputRange: [active ? 0.6 : 0.5, active ? 0.1 : 0.14] });

  return (
    <View style={s.orbStage}>
      <Animated.View style={[s.orbRing, { transform: [{ scale: ringScale }], opacity: ringOpacity }]} />
      <Animated.View style={[s.orb, { transform: [{ scale }] }]}>
        {/* layered circles fake the radial gradient highlight (no gradient dep) */}
        <View style={s.orbMid} />
        <View style={s.orbHi} />
      </Animated.View>
    </View>
  );
}

export default function App() {
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [ttsOn, setTtsOn] = useState(true);
  const chatId = useRef('chat_' + Date.now());
  const listRef = useRef();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const playerRef = useRef(null);

  const save = async () => {
    await SecureStore.setItemAsync('token', token);
    setSaved(true);
  };

  const addMsg = (role, text) => setMessages(m => [...m, { id: Date.now() + Math.floor(Math.random() * 1000), role, text }]);

  const send = async (override) => {
    const msg = (typeof override === 'string' ? override : input).trim();
    if (!msg) return;
    if (typeof override !== 'string') setInput('');
    addMsg('user', msg);
    setLoading(true);
    try {
      const r = await fetch(`${API}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, chat_id: chatId.current, message: msg })
      });
      const d = await r.json();
      const reply = d.reply || 'No response';
      addMsg('assistant', reply);
      speak(reply);
    } catch (e) {
      addMsg('assistant', 'Error: ' + e.message);
    }
    setLoading(false);
  };

  // --- Deepgram STT: record on tap, transcribe, insert + auto-send ---
  const toggleMic = async () => {
    if (recording) { await stopAndTranscribe(); return; }
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) { addMsg('assistant', 'Microphone permission denied.'); return; }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch (e) {
      setRecording(false);
      addMsg('assistant', 'Mic error: ' + e.message);
    }
  };

  const stopAndTranscribe = async () => {
    setRecording(false);
    setLoading(true);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) { setLoading(false); return; }
      const audioResp = await fetch(uri);
      const blob = await audioResp.blob();
      const dg = await fetch(DG_LISTEN, {
        method: 'POST',
        headers: { Authorization: 'Token ' + DEEPGRAM_KEY, 'Content-Type': 'audio/m4a' },
        body: blob,
      });
      const dj = await dg.json();
      const transcript = (dj?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
      setLoading(false);
      if (transcript) { await send(transcript); }
      else { addMsg('assistant', "(Didn't catch that — try again.)"); }
    } catch (e) {
      setLoading(false);
      addMsg('assistant', 'STT error: ' + e.message);
    }
  };

  // --- Deepgram Aura TTS: synthesize reply and play it back ---
  const speak = async (text) => {
    if (!ttsOn || !text) return;
    try {
      const res = await fetch(DG_SPEAK, {
        method: 'POST',
        headers: { Authorization: 'Token ' + DEEPGRAM_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const file = new File(Paths.cache, `tts_${Date.now()}.mp3`);
      file.create({ overwrite: true });
      file.write(bytes);
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      if (playerRef.current) { try { playerRef.current.remove(); } catch (_) {} }
      const player = createAudioPlayer({ uri: file.uri });
      playerRef.current = player;
      player.play();
    } catch (_) {
      // TTS is best-effort; ignore playback errors
    }
  };

  if (!saved) return (
    <SafeAreaView style={s.center}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <Text style={s.logo}>iVault AI</Text>
      <Text style={s.sub}>YOUR AI ASSISTANT</Text>
      <TextInput style={s.input} placeholder="Paste your token" placeholderTextColor="#666" value={token} onChangeText={setToken} autoCapitalize="none" />
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>Connect</Text></TouchableOpacity>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.flex}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      {/* 1. Header — iVault AI logo in green */}
      <View style={s.header}>
        <Text style={s.logo}>iVault AI</Text>
        <Text style={s.sub}>YOUR AI ASSISTANT</Text>
      </View>

      {/* 2. Orb — pulsing blue dot, center, idle animation */}
      <Orb active={recording} />
      <Text style={s.status}>{recording ? 'LISTENING…' : 'TAP TO TALK'}</Text>

      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <FlatList ref={listRef} style={s.flex} data={messages} keyExtractor={i => String(i.id)}
          onContentSizeChange={() => listRef.current?.scrollToEnd()}
          renderItem={({ item }) => (
            <View style={[s.bubble, item.role === 'user' ? s.user : s.assistant]}>
              <Text style={[s.msgText, item.role === 'user' && s.msgTextUser]}>{item.text}</Text>
            </View>
          )} />
        {loading && <ActivityIndicator color={C.accent} style={{ margin: 8 }} />}

        {/* 3. TAP TO TALK button at bottom — green pill */}
        <TouchableOpacity style={[s.talkBtn, recording && s.talkBtnActive]} onPress={toggleMic} activeOpacity={0.85}>
          <Text style={[s.talkText, recording && s.talkTextActive]}>{recording ? 'TAP TO STOP' : 'TAP TO TALK'}</Text>
        </TouchableOpacity>

        <View style={s.row}>
          <TouchableOpacity style={s.spk} onPress={() => setTtsOn(v => !v)}><Text style={s.icon}>{ttsOn ? '🔊' : '🔇'}</Text></TouchableOpacity>
          <TextInput style={s.input2} value={input} onChangeText={setInput} placeholder="Message..." placeholderTextColor="#666" onSubmitEditing={() => send()} returnKeyType="send" />
          <TouchableOpacity style={s.send} onPress={() => send()}><Text style={s.btnText}>Send</Text></TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const ORB = 128;
const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, backgroundColor: C.bg, justifyContent: 'center', padding: 24 },

  // Header
  header: { alignItems: 'center', paddingTop: 18, paddingBottom: 4 },
  logo: { color: C.accent, fontSize: 30, fontWeight: '700', textAlign: 'center', letterSpacing: 0.5 },
  sub: { color: C.accent, fontSize: 11, fontWeight: '600', letterSpacing: 4.5, textTransform: 'uppercase', textAlign: 'center', marginTop: 6, marginBottom: 20, opacity: 0.85 },

  // Orb
  orbStage: { width: 200, height: 200, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', marginVertical: 10 },
  orbRing: { position: 'absolute', width: ORB + 56, height: ORB + 56, borderRadius: (ORB + 56) / 2, borderWidth: 1, borderColor: 'rgba(30,144,255,0.5)' },
  orb: {
    width: ORB, height: ORB, borderRadius: ORB / 2, backgroundColor: C.orb3,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    shadowColor: C.orb2, shadowOpacity: 0.9, shadowRadius: 38, shadowOffset: { width: 0, height: 0 }, elevation: 16,
  },
  orbMid: { position: 'absolute', width: ORB * 0.82, height: ORB * 0.82, borderRadius: (ORB * 0.82) / 2, backgroundColor: C.orb2 },
  orbHi: { position: 'absolute', top: ORB * 0.16, left: ORB * 0.18, width: ORB * 0.5, height: ORB * 0.5, borderRadius: (ORB * 0.5) / 2, backgroundColor: C.orb1, opacity: 0.9 },
  status: { color: C.muted, fontSize: 12, letterSpacing: 3, textTransform: 'uppercase', textAlign: 'center', marginBottom: 8 },

  // Connect screen + generic buttons
  input: { borderWidth: 1, borderColor: '#333', color: '#fff', padding: 12, borderRadius: 8, marginBottom: 12 },
  btn: { backgroundColor: C.accent, padding: 14, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#000', fontWeight: 'bold' },

  // Chat bubbles
  bubble: { marginHorizontal: 12, marginVertical: 5, padding: 12, borderRadius: 14, maxWidth: '80%' },
  user: { backgroundColor: C.accent, alignSelf: 'flex-end', borderBottomRightRadius: 5 },
  assistant: { backgroundColor: 'rgba(255,255,255,0.06)', alignSelf: 'flex-start', borderBottomLeftRadius: 5 },
  msgText: { color: C.text },
  msgTextUser: { color: '#06101f', fontWeight: '600' },

  // TAP TO TALK button (green pill)
  talkBtn: {
    alignSelf: 'center', backgroundColor: C.accent, borderRadius: 40,
    paddingVertical: 17, paddingHorizontal: 52, marginTop: 6, marginBottom: 10,
    shadowColor: C.accent, shadowOpacity: 0.34, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8,
  },
  talkBtnActive: { backgroundColor: C.danger, shadowColor: C.danger },
  talkText: { color: '#06101f', fontSize: 15, fontWeight: '700', letterSpacing: 3, textTransform: 'uppercase' },
  talkTextActive: { color: '#fff' },

  // Bottom input row
  row: { flexDirection: 'row', alignItems: 'center', padding: 8, backgroundColor: '#0d0d0d', paddingBottom: 16 },
  input2: { flex: 1, borderWidth: 1, borderColor: 'rgba(0,255,136,0.18)', color: '#fff', padding: 10, borderRadius: 12, marginRight: 8 },
  send: { backgroundColor: C.accent, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 12, justifyContent: 'center' },
  spk: { padding: 8, justifyContent: 'center', alignItems: 'center', marginRight: 4 },
  icon: { fontSize: 18, color: '#fff' },
});
