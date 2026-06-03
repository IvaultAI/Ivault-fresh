import { useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, SafeAreaView, StatusBar } from 'react-native';
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
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <Text style={s.title}>iVault AI</Text>
      <TextInput style={s.input} placeholder="Paste your token" placeholderTextColor="#666" value={token} onChangeText={setToken} autoCapitalize="none" />
      <TouchableOpacity style={s.btn} onPress={save}><Text style={s.btnText}>Connect</Text></TouchableOpacity>
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={s.flex}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <FlatList ref={listRef} style={s.flex} data={messages} keyExtractor={i => String(i.id)}
          onContentSizeChange={() => listRef.current?.scrollToEnd()}
          renderItem={({ item }) => (
            <View style={[s.bubble, item.role === 'user' ? s.user : s.assistant]}>
              <Text style={s.msgText}>{item.text}</Text>
            </View>
          )} />
        {loading && <ActivityIndicator color="#00ff88" style={{ margin: 8 }} />}
        <View style={s.row}>
          <TouchableOpacity style={s.spk} onPress={() => setTtsOn(v => !v)}><Text style={s.icon}>{ttsOn ? '🔊' : '🔇'}</Text></TouchableOpacity>
          <TouchableOpacity style={[s.mic, recording && s.micActive]} onPress={toggleMic}><Text style={s.icon}>{recording ? '■' : '🎤'}</Text></TouchableOpacity>
          <TextInput style={s.input2} value={input} onChangeText={setInput} placeholder="Message..." placeholderTextColor="#666" onSubmitEditing={() => send()} returnKeyType="send" />
          <TouchableOpacity style={s.send} onPress={() => send()}><Text style={s.btnText}>Send</Text></TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#0a0a0a' },
  center: { flex: 1, backgroundColor: '#0a0a0a', justifyContent: 'center', padding: 24 },
  title: { color: '#00ff88', fontSize: 28, fontWeight: 'bold', textAlign: 'center', marginBottom: 32 },
  input: { borderWidth: 1, borderColor: '#333', color: '#fff', padding: 12, borderRadius: 8, marginBottom: 12 },
  btn: { backgroundColor: '#00ff88', padding: 14, borderRadius: 8, alignItems: 'center' },
  btnText: { color: '#000', fontWeight: 'bold' },
  bubble: { margin: 8, padding: 12, borderRadius: 12, maxWidth: '80%' },
  user: { backgroundColor: '#1a3a2a', alignSelf: 'flex-end' },
  assistant: { backgroundColor: '#1a1a2a', alignSelf: 'flex-start' },
  msgText: { color: '#fff' },
  row: { flexDirection: 'row', alignItems: 'center', padding: 8, backgroundColor: '#111', paddingBottom: 16 },
  input2: { flex: 1, borderWidth: 1, borderColor: '#333', color: '#fff', padding: 10, borderRadius: 8, marginRight: 8 },
  send: { backgroundColor: '#00ff88', padding: 10, borderRadius: 8, justifyContent: 'center' },
  spk: { padding: 8, justifyContent: 'center', alignItems: 'center', marginRight: 4 },
  mic: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#1a1a2a', justifyContent: 'center', alignItems: 'center', marginRight: 8 },
  micActive: { backgroundColor: '#cc2b2b' },
  icon: { fontSize: 18, color: '#fff' },
});
