import React, { useState, useEffect, useRef } from 'react';
import { 
  Terminal, 
  Send, 
  ShieldCheck, 
  Hash, 
  Phone, 
  Play, 
  StopCircle, 
  Info, 
  CheckCircle2, 
  AlertCircle,
  Cpu,
  User,
  Zap,
  Power,
  PauseCircle,
  PlayCircle,
  Database,
  MessageSquare
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Log {
  timestamp: string;
  type: 'info' | 'success' | 'error';
  message: string;
}

interface QAPair {
  id: string;
  phoneNumber?: string;
  question: string;
  answer: string;
}

interface Bot {
  phoneNumber: string;
  isActive: boolean;
  isOffline?: boolean;
  offlineMessage?: string;
}

export default function App() {
  const [step, setStep] = useState(1);
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [bots, setBots] = useState<Bot[]>([]);
  const [qaPairs, setQaPairs] = useState<QAPair[]>([]);
  const [selectedQABot, setSelectedQABot] = useState<string>('');
  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswer, setNewAnswer] = useState('');
  const [offlineMessageModal, setOfflineMessageModal] = useState<{isOpen: boolean; phone: string; message: string}>({isOpen: false, phone: '', message: ''});
  const [aiConfig, setAiConfig] = useState({ provider: 'openrouter', geminiKey: '', openRouterKey: '' });
  const [isSavingAiConfig, setIsSavingAiConfig] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);

  const handlePointerDown = (id: string) => {
    longPressTimerRef.current = setTimeout(() => {
      const confirmDelete = window.confirm('Delete this custom Q&A?');
      if (confirmDelete) {
        handleDeleteQA(id);
      }
    }, 800);
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // SSE for logs
  useEffect(() => {
    let eventSource: EventSource;

    const fetchAiConfig = async () => {
      try {
        const res = await fetch('/api/bot/ai-config');
        const data = await res.json();
        if (data.aiConfig) {
          setAiConfig(data.aiConfig);
        }
      } catch (err) {
        console.error('Failed to load AI config', err);
      }
    };
    fetchAiConfig();
    
    const connectSSE = () => {
      eventSource = new EventSource('/api/bot/logs');
      
      eventSource.onmessage = (event) => {
        try {
          const log = JSON.parse(event.data);
          setLogs((prev) => [...prev, log].slice(-100));
        } catch (e) {
          // Ignore heartbeat or malformed logs
        }
      };

      eventSource.onerror = (err) => {
        console.warn('SSE Connection lost. Retrying in 3s...', err);
        eventSource.close();
        setTimeout(connectSSE, 3000);
      };
    };

    connectSSE();
    return () => eventSource?.close();
  }, []);

  // Poll for bot status
  useEffect(() => {
    const fetchBots = async () => {
      try {
        const res = await fetch('/api/bot/status');
        const contentType = res.headers.get('content-type');
        if (!res.ok || !contentType?.includes('application/json')) {
          throw new Error('Invalid response from server');
        }
        const data = await res.json();
        setBots(data.bots || []);
        if (data.bots && data.bots.length > 0) {
          setSelectedQABot(prev => prev || data.bots[0].phoneNumber);
        }
      } catch (err) {
        // Quietly fail for status polling but log to console
        console.debug('Status poll failed', err);
      }

      try {
        const qaRes = await fetch('/api/bot/qa');
        const qaData = await qaRes.json();
        setQaPairs(qaData.qa || []);
      } catch (err) {
        console.debug('QA poll failed', err);
      }
    };
    fetchBots();
    const interval = setInterval(fetchBots, 5000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll terminal
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bot/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiId, apiHash, phoneNumber }),
      });
      const data = await res.json();
      if (data.success) {
        setStep(2);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bot/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, code: otp, apiId, apiHash }),
      });
      const data = await res.json();
      if (data.requiresPassword) {
        setStep(3);
      } else if (data.success) {
        resetForm();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/bot/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, password, apiId, apiHash }),
      });
      const data = await res.json();
      if (data.success) {
        resetForm();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Password rejected');
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (phone: string, currentActive: boolean) => {
    try {
      const targetState = !currentActive;
      const res = await fetch('/api/bot/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone, isActive: targetState }),
      });
      const data = await res.json();
      if (data.success) {
        setBots(prev => prev.map(bot => bot.phoneNumber === phone ? { ...bot, isActive: data.isActive } : bot));
      }
    } catch (err) {
      console.error('Failed to toggle bot', err);
    }
  };

  const handleToggleOffline = async (phone: string, currentOffline: boolean) => {
    try {
      const isOffline = !currentOffline;
      await fetch('/api/bot/toggle-offline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone, isOffline }),
      });
      // Optimistically update
      setBots(prev => prev.map(bot => bot.phoneNumber === phone ? { ...bot, isOffline } : bot));
    } catch (err) {
      console.error('Failed to toggle offline mode', err);
    }
  };

  const handleUpdateOfflineMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await fetch('/api/bot/update-offline-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: offlineMessageModal.phone, message: offlineMessageModal.message }),
      });
      setBots(prev => prev.map(bot => bot.phoneNumber === offlineMessageModal.phone ? { ...bot, offlineMessage: offlineMessageModal.message } : bot));
      setOfflineMessageModal({ isOpen: false, phone: '', message: '' });
    } catch (err) {
      console.error('Failed to update offline message', err);
    }
  };

  const handleStop = async (phone: string) => {
    try {
      await fetch('/api/bot/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone }),
      });
    } catch (err) {
      console.error('Failed to stop bot', err);
    }
  };

  const handleSaveAiConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingAiConfig(true);
    try {
      const res = await fetch('/api/bot/ai-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiConfig),
      });
      const data = await res.json();
      if (data.success) {
        setAiConfig(data.aiConfig);
      }
    } catch (err) {
      console.error('Failed to save AI config', err);
    } finally {
      setIsSavingAiConfig(false);
    }
  };

  const handleAddQA = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestion.trim() || !newAnswer.trim() || !selectedQABot) return;
    
    try {
      const res = await fetch('/api/bot/qa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: newQuestion, answer: newAnswer, phoneNumber: selectedQABot }),
      });
      const data = await res.json();
      if (data.success) {
        setQaPairs(data.qa);
        setNewQuestion('');
        setNewAnswer('');
      }
    } catch (err) {
      console.error('Failed to add QA', err);
    }
  };

  const handleDeleteQA = async (id: string) => {
    try {
      const res = await fetch(`/api/bot/qa/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setQaPairs(data.qa);
      }
    } catch (err) {
      console.error('Failed to delete QA', err);
    }
  };

  const resetForm = () => {
    setStep(1);
    setPhoneNumber('');
    setOtp('');
    setPassword('');
    setApiId('');
    setApiHash('');
  };

  return (
    <div className="min-h-screen bg-[#0A0C10] text-slate-200 font-sans selection:bg-blue-500/30 p-6 flex flex-col gap-6 overflow-x-hidden">
      {/* Background Glow */}
      <div className="fixed inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(37,99,235,0.1),rgba(0,0,0,0))] pointer-events-none" />
      
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-slate-900/40 border border-slate-800 rounded-2xl backdrop-blur-md relative z-10">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(37,99,235,0.4)]">
            <Cpu className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="font-bold text-xl leading-tight tracking-tight text-white flex items-center gap-2">
              7H SIAM <span className="text-blue-500">AI BOT</span>
            </h1>
            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-mono">MTProto v2.48 • OpenRouter Core</p>
          </div>
        </div>

        <div className="flex items-center gap-8">
          <div className="hidden md:flex flex-col items-end">
            <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">System Cluster</span>
            <span className="flex items-center gap-2 text-xs font-mono text-emerald-400">
              <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span> OPERATIONAL
            </span>
          </div>
          <div className="h-8 w-[1px] bg-slate-800 hidden md:block"></div>
          <div className="flex items-center gap-3">
             <div className="p-2 rounded-lg bg-slate-800/50 border border-slate-700/50 text-slate-400">
               <User className="w-4 h-4" />
             </div>
             <Power className="w-5 h-5 text-red-500/50 hover:text-red-500 cursor-pointer transition-colors" />
          </div>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-12 gap-6 min-h-0 relative z-10">
        
        {/* Left Section: Control Panel */}
        <div className="col-span-12 lg:col-span-4 flex flex-col gap-6">
          
          {/* Auth Card */}
          <section className="bg-slate-900/40 border border-slate-800 rounded-3xl p-8 backdrop-blur-md flex-1 relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-8 opacity-[0.03] group-hover:opacity-[0.07] transition-opacity pointer-events-none">
              <ShieldCheck className="w-48 h-48" />
            </div>

            <div className="flex items-center gap-3 mb-8">
              <div className="w-1.5 h-6 bg-blue-500 rounded-full"></div>
              <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-slate-400">Initialization</h2>
            </div>

            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.form 
                  key="step1"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  onSubmit={handleSendCode} 
                  className="space-y-5"
                >
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase ml-1 tracking-widest">Telegram API ID</label>
                    <div className="relative">
                      <Hash className="absolute left-3 top-3 w-4 h-4 text-slate-600" />
                      <input 
                        type="text" 
                        value={apiId} 
                        onChange={(e) => setApiId(e.target.value)}
                        placeholder="284...32"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-sm font-mono focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-800"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase ml-1 tracking-widest">API Hash</label>
                    <div className="relative">
                      <ShieldCheck className="absolute left-3 top-3 w-4 h-4 text-slate-600" />
                      <input 
                        type="password" 
                        value={apiHash} 
                        onChange={(e) => setApiHash(e.target.value)}
                        placeholder="••••••••••••••••"
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-sm font-mono focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-800"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase ml-1 tracking-widest">Phone Axis</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-3 w-4 h-4 text-slate-600" />
                      <input 
                        type="text" 
                        value={phoneNumber} 
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        placeholder="+88017..."
                        className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-10 pr-4 py-3 text-sm font-mono focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 outline-none transition-all placeholder:text-slate-800"
                        required
                      />
                      <span className="absolute right-3 top-2.5 text-[9px] bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700 text-slate-500 font-bold uppercase tracking-tighter">Global</span>
                    </div>
                  </div>

                  <div className="pt-4">
                    <button 
                      disabled={loading}
                      className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white font-black py-4 rounded-2xl transition-all shadow-[0_4px_30px_rgba(37,99,235,0.25)] flex items-center justify-center gap-3 active:scale-[0.98] disabled:cursor-not-allowed group"
                    >
                      {loading ? (
                        <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      ) : (
                        <>
                          <Zap className="w-5 h-5 group-hover:animate-pulse" />
                          INITIATE LINK
                        </>
                      )}
                    </button>
                    {error && (
                      <p className="text-red-400 text-[11px] font-mono mt-3 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-lg flex items-center gap-2">
                        <AlertCircle className="w-3.5 h-3.5" /> ERR: {error.toUpperCase()}
                      </p>
                    )}
                  </div>
                </motion.form>
              )}

              {step === 2 && (
                <motion.form 
                  key="step2"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  onSubmit={handleVerify} 
                  className="space-y-5"
                >
                  <p className="text-[11px] text-slate-500 leading-relaxed font-medium uppercase tracking-tight">Access code dispatched to remote instance. Decrypt and enter below.</p>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase ml-1 tracking-widest">Verification Node</label>
                    <input 
                      type="text" 
                      value={otp} 
                      onChange={(e) => setOtp(e.target.value)}
                      placeholder="00000"
                      className="w-full bg-slate-950 border border-slate-800 rounded-2xl px-4 py-6 text-center text-3xl font-mono font-black tracking-[0.3em] focus:border-blue-500/50 outline-none transition-all"
                      required
                    />
                  </div>
                  <button 
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white font-black py-4 rounded-2xl transition-all shadow-[0_4px_30px_rgba(37,99,235,0.25)]"
                  >
                    {loading ? 'SYNCHRONIZING...' : 'EXECUTE AUTH'}
                  </button>
                  <button type="button" onClick={() => setStep(1)} className="w-full text-slate-600 text-[10px] font-bold uppercase tracking-widest hover:text-white transition-colors">Aborted</button>
                  {error && <p className="text-red-400 text-[11px] font-mono mt-2 bg-red-500/10 px-3 py-2 rounded-lg">ERR: {error}</p>}
                </motion.form>
              )}

              {step === 3 && (
                <motion.form 
                  key="step3"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  onSubmit={handlePassword} 
                  className="space-y-5"
                >
                  <div className="flex items-center gap-2 p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl">
                    <Info className="w-4 h-4 text-amber-500" />
                    <p className="text-[10px] text-amber-500/80 font-bold uppercase">Cloud Layer Protected - Password Required</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-500 uppercase ml-1">Secure Keyphrase</label>
                    <input 
                      type="password" 
                      value={password} 
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm font-mono focus:border-blue-500/50 outline-none transition-all"
                      required
                    />
                  </div>
                  <button 
                    disabled={loading}
                    className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 text-white font-black py-4 rounded-2xl transition-all"
                  >
                    {loading ? 'PENETRATING...' : 'BYPASS LAYER'}
                  </button>
                  {error && <p className="text-red-400 text-[11px] font-mono mt-2 bg-red-500/10 px-3 py-2 rounded-lg">ERR: {error}</p>}
                </motion.form>
              )}
            </AnimatePresence>

            {/* Stepper Visualizer */}
            <div className="mt-12 flex justify-between px-2 relative">
              <div className="absolute top-4 left-8 right-8 h-[1px] bg-slate-800 z-0"></div>
              <StepItem num={1} label="CONFIG" active={step >= 1} />
              <StepItem num={2} label="VERIFY" active={step >= 2} />
              <StepItem num={3} label="READY" active={step >= 3} />
            </div>
          </section>

          {/* AI Settings Form */}
          <section className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 backdrop-blur-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">AI Configuration</h3>
              <span className="text-[9px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-0.5 rounded tracking-tighter font-bold">GEMINI 2.5 FLASH</span>
            </div>
            <form onSubmit={handleSaveAiConfig} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest block mb-2">Provider Toggle</label>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setAiConfig(prev => ({ ...prev, provider: 'gemini'}))} className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase transition-all ${aiConfig.provider === 'gemini' ? 'bg-blue-600 text-white border-blue-500' : 'bg-slate-900/50 text-slate-500 border-slate-800 hover:text-slate-300'} border`}>Gemini NATIVE</button>
                  <button type="button" onClick={() => setAiConfig(prev => ({ ...prev, provider: 'openrouter'}))} className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase transition-all ${aiConfig.provider === 'openrouter' ? 'bg-blue-600 text-white border-blue-500' : 'bg-slate-900/50 text-slate-500 border-slate-800 hover:text-slate-300'} border`}>OpenRouter</button>
                </div>
              </div>
              
              {aiConfig.provider === 'openrouter' && (
                <div className="space-y-1.5 animate-in fade-in slide-in-from-top-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase ml-1 tracking-widest">OpenRouter KEY</label>
                  <input 
                    type="password" 
                    value={aiConfig.openRouterKey} 
                    onChange={(e) => setAiConfig(prev => ({ ...prev, openRouterKey: e.target.value}))}
                    placeholder="sk-or-v1-..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm font-mono focus:border-blue-500/50 outline-none transition-all"
                  />
                </div>
              )}

              {aiConfig.provider === 'gemini' && (
                <div className="space-y-1.5 animate-in fade-in slide-in-from-top-2">
                  <label className="text-[10px] font-bold text-slate-500 uppercase ml-1 tracking-widest">GEMINI STUDIO KEY</label>
                  <input 
                    type="password" 
                    value={aiConfig.geminiKey} 
                    onChange={(e) => setAiConfig(prev => ({ ...prev, geminiKey: e.target.value}))}
                    placeholder="AIzaSy..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 text-sm font-mono focus:border-blue-500/50 outline-none transition-all"
                  />
                </div>
              )}

              <button 
                type="submit"
                disabled={isSavingAiConfig}
                className="w-full bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white border border-blue-500/30 text-xs font-bold py-2 rounded-lg transition-all disabled:opacity-50"
              >
                {isSavingAiConfig ? 'SAVING...' : 'SAVE AI CONFIG'}
              </button>
            </form>
          </section>

          {/* Custom QA Config */}
          <section className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 backdrop-blur-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Custom Q&A List</h3>
            </div>
            
            <div className="mb-4">
              <select 
                value={selectedQABot}
                onChange={(e) => setSelectedQABot(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-blue-500/50 outline-none transition-all text-slate-300"
              >
                <option value="" disabled>Select an active bot</option>
                {bots.map(bot => (
                  <option key={bot.phoneNumber} value={bot.phoneNumber}>{bot.phoneNumber}</option>
                ))}
              </select>
            </div>

            <form onSubmit={handleAddQA} className="space-y-3 mb-4">
              <input 
                type="text" 
                value={newQuestion}
                onChange={(e) => setNewQuestion(e.target.value)}
                placeholder="Custom Question (e.g., Hello, Help)"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-blue-500/50 outline-none transition-all disabled:opacity-50"
                required
                disabled={!selectedQABot}
              />
              <input 
                type="text" 
                value={newAnswer}
                onChange={(e) => setNewAnswer(e.target.value)}
                placeholder="Custom Answer"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs focus:border-blue-500/50 outline-none transition-all disabled:opacity-50"
                required
                disabled={!selectedQABot}
              />
              <button 
                type="submit"
                className="w-full bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white border border-blue-500/30 text-xs font-bold py-2 rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={!selectedQABot}
              >
                + ADD QA PAIR
              </button>
            </form>

            <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-1">
              {qaPairs.filter(qa => qa.phoneNumber === selectedQABot).length === 0 ? (
                <p className="text-[10px] text-slate-600 text-center uppercase tracking-wider py-2">No custom QA configured</p>
              ) : (
                qaPairs.filter(qa => qa.phoneNumber === selectedQABot).map(qa => (
                  <div 
                    key={qa.id} 
                    className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 flex items-start gap-2 group relative cursor-pointer select-none"
                    onPointerDown={() => handlePointerDown(qa.id)}
                    onPointerUp={clearLongPress}
                    onPointerLeave={clearLongPress}
                    onPointerCancel={clearLongPress}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-bold text-slate-300 truncate">Q: {qa.question}</p>
                      <p className="text-[10px] text-slate-500 truncate">A: {qa.answer}</p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => handleDeleteQA(qa.id)}
                      className="text-slate-600 hover:text-red-500 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      X
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

        </div>

        {/* Right Section: Dashboard & Terminal */}
        <div className="col-span-12 lg:col-span-8 flex flex-col gap-6 min-h-0">
          
          {/* Metrics Dashboard */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MetricCard label="Relayed Traffic" value={logs.filter(l => l.type === 'success').length.toString()} unit="PKTS" />
            <MetricCard label="Active Clusters" value={bots.length.toString().padStart(2, '0')} unit="NODE" color="text-emerald-400" />
            <MetricCard label="Logic Latency" value={(Math.floor(Math.random() * 100) + 150).toString()} unit="MS" color="text-amber-400" />
          </div>

          {/* Terminal Console */}
          <div className="flex-1 bg-black/60 border border-slate-800 rounded-3xl flex flex-col overflow-hidden relative shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
            {/* Terminal Header */}
            <div className="bg-slate-900/80 border-b border-slate-800 px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/40"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-amber-500/40"></div>
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/40"></div>
                </div>
                <span className="text-[10px] font-mono font-bold text-slate-500 flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5" />
                  root@7h-siam-bot:~# <span className="text-slate-400">tail -f system.log</span>
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[9px] font-mono text-emerald-400/50 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                  SSE_FEED_STABLE
                </span>
              </div>
            </div>
            
            {/* Terminal Body */}
            <div className="flex-1 overflow-y-auto p-6 font-mono text-[11px] space-y-1.5 custom-scrollbar scroll-smooth">
              {logs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center opacity-20">
                  <Cpu className="w-12 h-12 mb-4 animate-pulse" />
                  <p className="uppercase tracking-[0.3em] font-black italic">Awaiting Logic Handshake</p>
                </div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="flex gap-3 items-start animate-in fade-in slide-in-from-left-4 duration-500">
                    <span className="text-slate-700 shrink-0 select-none">[{log.timestamp}]</span>
                    <span className={`font-bold shrink-0 ${
                      log.type === 'error' ? 'text-red-500/80' : 
                      log.type === 'success' ? 'text-emerald-400' : 'text-blue-400'
                    }`}>
                      {log.type.toUpperCase()}
                    </span>
                    <span className="text-slate-300 leading-relaxed font-medium">➔ {log.message}</span>
                  </div>
                ))
              )}
              <div ref={terminalEndRef} />
            </div>

            {/* Prompt */}
            <div className="bg-slate-900/30 border-t border-slate-800 px-5 py-3 flex items-center gap-3">
              <span className="text-emerald-500 animate-pulse font-black">❯</span>
              <span className="text-[10px] text-slate-600 font-bold uppercase tracking-widest">Listening for MTProto Events...</span>
              <div className="w-2 h-4 bg-slate-700 animate-pulse ml-auto" />
            </div>
          </div>

          {/* Session Manager */}
          <div className="min-h-[112px] bg-slate-900/40 border border-slate-800 rounded-3xl p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 backdrop-blur-md relative overflow-hidden">
             <div className="absolute inset-y-0 left-0 w-1 bg-cyan-500/20" />
            
            <div className="flex items-center gap-5 shrink-0">
              <div className="w-14 h-14 bg-slate-950 border border-slate-800 rounded-2xl flex items-center justify-center shadow-inner group shrink-0">
                <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)] group-hover:scale-150 transition-transform" />
              </div>
              <div>
                <h4 className="text-sm font-black text-white uppercase tracking-wider">Cluster Dashboard</h4>
                <p className="text-[10px] text-slate-500 font-mono mt-0.5">Management for {bots.length} active Telegram nodes</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 w-full md:w-auto md:max-w-[70%] md:justify-end">
              {bots.map((bot) => (
                <div key={bot.phoneNumber} className={`w-full sm:w-auto bg-slate-950 border pl-4 py-2 pr-2 rounded-xl flex items-center justify-between gap-4 group transition-all ${bot.isActive ? 'border-slate-800 hover:border-emerald-500/30' : 'border-amber-500/50 opacity-80'}`}>
                  <div className="flex-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-4">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${bot.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                      <span className="text-[11px] font-mono font-bold text-slate-400 whitespace-nowrap">{bot.phoneNumber}</span>
                    </div>

                    <div className="flex items-center gap-2 sm:mr-4 border-l border-slate-800 pl-4 ml-2">
                      <span className="text-[9px] uppercase font-bold text-slate-500 tracking-wider">
                        {bot.isOffline ? 'Offline Mode' : 'Online Mode'}
                      </span>
                      <button
                        onClick={() => handleToggleOffline(bot.phoneNumber, !!bot.isOffline)}
                        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${bot.isOffline ? 'bg-red-500/80' : 'bg-emerald-500/80'}`}
                        title={bot.isOffline ? 'Offline Mode is ON' : 'Online Mode is ON'}
                      >
                        <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${bot.isOffline ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
                      </button>
                      
                      <button
                        onClick={() => setOfflineMessageModal({ isOpen: true, phone: bot.phoneNumber, message: bot.offlineMessage || ''})}
                        className="ml-2 p-1.5 text-slate-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-md transition-colors"
                        title="Edit Offline Auto-Reply Message"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button 
                      onClick={() => handleToggle(bot.phoneNumber, !!bot.isActive)}
                      className={`p-2 rounded-lg transition-all ${bot.isActive ? 'text-amber-500 hover:bg-amber-500/10' : 'text-emerald-500 hover:bg-emerald-500/10'}`}
                      title={bot.isActive ? "Pause Instance" : "Resume Instance"}
                    >
                      {bot.isActive ? <PauseCircle className="w-4 h-4" /> : <PlayCircle className="w-4 h-4" />}
                    </button>
                    <button 
                      onClick={() => handleStop(bot.phoneNumber)}
                      className="p-2 text-slate-600 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all"
                      title="Terminate Instance (Logout)"
                    >
                      <StopCircle className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      </main>

      <AnimatePresence>
        {offlineMessageModal.isOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setOfflineMessageModal({ isOpen: false, phone: '', message: '' })}
          >
            <motion.div 
              initial={{ scale: 0.95, y: 10 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 10 }}
              onClick={e => e.stopPropagation()}
              className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
            >
              <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900/50">
                <h3 className="text-white font-bold text-sm tracking-wide">Edit Offline Auto-Reply</h3>
                <button 
                  onClick={() => setOfflineMessageModal({ isOpen: false, phone: '', message: '' })}
                  className="text-slate-500 hover:text-white transition-colors"
                >
                  <StopCircle className="w-5 h-5 rotate-45" />
                </button>
              </div>
              <form onSubmit={handleUpdateOfflineMessage} className="p-5">
                <div className="mb-4">
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                    Target Node
                  </label>
                  <div className="text-emerald-400 font-mono text-sm bg-slate-950 border border-slate-800 px-3 py-2 rounded-lg">
                    {offlineMessageModal.phone}
                  </div>
                </div>
                <div className="mb-6">
                  <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                    Message Content
                  </label>
                  <textarea
                    value={offlineMessageModal.message}
                    onChange={(e) => setOfflineMessageModal(prev => ({ ...prev, message: e.target.value }))}
                    placeholder="Enter offline auto-reply message..."
                    rows={5}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm text-slate-300 focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 outline-none transition-all resize-none custom-scrollbar"
                  />
                  <p className="mt-2 text-[10px] text-slate-600">This message will be sent automatically when the node is in OFFLINE mode.</p>
                </div>
                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setOfflineMessageModal({ isOpen: false, phone: '', message: '' })}
                    className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white transition-colors"
                  >
                    CANCEL
                  </button>
                  <button
                    type="submit"
                    className="px-6 py-2 bg-blue-600/20 text-blue-400 hover:bg-blue-600 hover:text-white border border-blue-500/30 text-xs font-bold rounded-lg transition-all"
                  >
                    SAVE CHANGES
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Global Status Bar */}
      <footer className="mt-2 flex justify-between items-center text-[10px] text-slate-600 border-t border-white/5 pt-4 px-2">
        <div className="flex gap-6 font-bold tracking-tight">
          <span className="flex items-center gap-2 hover:text-slate-400 cursor-help transition-colors"><div className="w-1 h-1 bg-blue-500 rounded-full" /> VITE REACT x64</span>
          <span className="flex items-center gap-2 hover:text-slate-400 cursor-help transition-colors"><div className="w-1 h-1 bg-blue-500 rounded-full" /> EXPRESS TS ENGINE</span>
          <span className="flex items-center gap-2 hover:text-slate-400 cursor-help transition-colors"><div className="w-1 h-1 bg-blue-500 rounded-full" /> SSE FEED 1.02</span>
        </div>
        <div className="font-mono uppercase text-[9px] tracking-widest text-slate-700">
           © 2026 7H SIAM — ALL SYSTEMS NOMINAL • [BUILD v0.4.82]
        </div>
      </footer>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(37,99,235,0.1); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(37,99,235,0.3); }
      `}</style>
    </div>
  );
}

function StepItem({ num, label, active = false }: { num: number, label: string, active?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2.5 relative z-10 transition-all duration-500">
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-black border-2 transition-all ${
        active 
          ? 'bg-blue-600 border-blue-400 text-white shadow-[0_0_15px_rgba(37,99,235,0.5)]' 
          : 'bg-slate-950 border-slate-800 text-slate-700'
      }`}>
        {num}
      </div>
      <span className={`text-[9px] font-black tracking-[0.2em] transition-colors ${
        active ? 'text-blue-500' : 'text-slate-700'
      }`}>{label}</span>
    </div>
  );
}

function MetricCard({ label, value, unit, color = 'text-white' }: { label: string, value: string, unit: string, color?: string }) {
  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-5 backdrop-blur-md relative overflow-hidden group">
      <div className="absolute top-0 left-0 w-1 h-full bg-blue-500/0 group-hover:bg-blue-500/20 transition-all" />
      <span className="text-[10px] text-slate-500 uppercase font-black tracking-widest">{label}</span>
      <div className="flex items-baseline gap-2 mt-2">
        <p className={`text-3xl font-mono font-black tracking-tighter ${color}`}>{value}</p>
        <span className="text-[9px] text-slate-600 font-bold uppercase">{unit}</span>
      </div>
    </div>
  );
}
