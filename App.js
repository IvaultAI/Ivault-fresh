import { useState, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, SafeAreaView, StatusBar } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const API = 'https://api.ivaultai.com';

export default function App() {
  const [token, setToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const chatId = useRef('chat_' + Date.now());
  const listRef = useRef();

  const save = async () => {
    await SecureStore.setItemAsync('token', token);
    setSaved(true);
  };

  const send = async () => {
    if (!input.trim()) return;
    const msg = input.trim();
    setInput('');
    setMessages(m => [...m, { id: Date.now(), role: 'user', text: msg }]);
    setLoading(true);
    try {
      const r = await fetch(`${API}/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, chat_id: chatId.current, message: msg })
      });
      const d = await r.json();
      setMessages(m => [...m, { id: Date.now() + 1, role: 'assistant', text: d.reply || 'No response' }]);
    } catch (e) {
      setMessages(m => [...m, { id: Date.now() + 1, role: 'assistant', text: 'Error: ' + e.message }]);
    }
    setLoading(false);
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
          <TextInput style={s.input2} value={input} onChangeText={setInput} placeholder="Message..." placeholderTextColor="#666" onSubmitEditing={send} returnKeyType="send" />
          <TouchableOpacity style={s.send} onPress={send}><Text style={s.btnText}>Send</Text></TouchableOpacity>
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
  row: { flexDirection: 'row', padding: 8, backgroundColor: '#111', paddingBottom: 16 },
  input2: { flex: 1, borderWidth: 1, borderColor: '#333', color: '#fff', padding: 10, borderRadius: 8, marginRight: 8 },
  send: { backgroundColor: '#00ff88', padding: 10, borderRadius: 8, justifyContent: 'center' },
});
