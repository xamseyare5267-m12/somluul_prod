import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Radio, Eye, Heart, MessageCircle, Gift, X, Video, PhoneOff } from 'lucide-react';
import { useLanguage } from './LanguageContext.js';
import { playNotifByType } from '../lib/soundUtils.js';

interface LiveSectionProps {
  user?: any;
  authToken?: string;
  onShowToast?: (m: string, t: 'success' | 'error') => void;
}

const GIFTS = [
  { id: 'rose', name: '🌹 Rose', coins: 5 },
  { id: 'fire', name: '🔥 Fire', coins: 20 },
  { id: 'diamond', name: '💎 Diamond', coins: 50 },
  { id: 'rocket', name: '🚀 Rocket', coins: 100 },
  { id: 'crown', name: '👑 Crown', coins: 200 },
];

export const LiveSection: React.FC<LiveSectionProps> = ({ user, authToken, onShowToast }) => {
  const { language } = useLanguage();
  const [lives, setLives] = useState<any[]>([]);
  const [activeLive, setActiveLive] = useState<any | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [comment, setComment] = useState('');
  const [title, setTitle] = useState('');
  const localRef = useRef<HTMLVideoElement>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pollRef = useRef<any>(null);
  const signalRef = useRef<any>(null);

  const loadLives = async () => {
    try {
      const res = await axios.get('/api/live');
      setLives(res.data || []);
    } catch {
      setLives([]);
    }
  };

  useEffect(() => {
    loadLives();
    const i = setInterval(loadLives, 5000);
    return () => clearInterval(i);
  }, []);

  const cleanupMedia = () => {
    if (signalRef.current) clearInterval(signalRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
    if (pcRef.current) { try { pcRef.current.close(); } catch {} pcRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (localRef.current) localRef.current.srcObject = null;
    if (remoteRef.current) remoteRef.current.srcObject = null;
  };

  const startLive = async () => {
    if (!authToken) return;
    try {
      const res = await axios.post('/api/live/start', { title: title || undefined }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const live = res.data;
      setActiveLive(live);
      setIsHost(true);
      playNotifByType('live');

      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      if (localRef.current) localRef.current.srcObject = stream;

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443'], username: 'openrelayproject', credential: 'openrelayproject' }]
      });
      pcRef.current = pc;
      stream.getTracks().forEach(t => pc.addTrack(t, stream));

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          axios.post('/api/webrtc/signal', {
            roomId: live.id, type: 'ice', candidate: ev.candidate
          }, { headers: { Authorization: `Bearer ${authToken}` } }).catch(() => {});
        }
      };

      // Host waits for viewer offers? Simpler: host creates offer; viewers answer.
      // For multi-viewer without SFU: host posts offer periodically isn't ideal.
      // Approach: viewers send "viewer_join"; host creates offer per... complex.
      // Practical: host broadcasts local preview; signaling for 1 primary viewer P2P;
      // comments/gifts work for everyone via API poll.

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await axios.post('/api/webrtc/signal', {
        roomId: live.id, type: 'offer', sdp: offer
      }, { headers: { Authorization: `Bearer ${authToken}` } });

      signalRef.current = setInterval(async () => {
        try {
          const sRes = await axios.get('/api/webrtc/signal', {
            params: { roomId: live.id },
            headers: { Authorization: `Bearer ${authToken}` }
          });
          for (const s of (sRes.data?.signals || [])) {
            if (s.type === 'answer' && s.sdp && pcRef.current) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(s.sdp));
            } else if (s.type === 'ice' && s.candidate && pcRef.current) {
              try { await pcRef.current.addIceCandidate(new RTCIceCandidate(s.candidate)); } catch {}
            }
          }
        } catch {}
      }, 2000);

      pollRef.current = setInterval(async () => {
        try {
          const r = await axios.get(`/api/live/${live.id}`);
          setActiveLive(r.data);
        } catch {}
      }, 3000);

      onShowToast?.(language === 'so' ? 'Live waa bilowday! 🔴' : 'You are live! 🔴', 'success');
      loadLives();
    } catch (e: any) {
      onShowToast?.(e?.response?.data?.error || 'Failed to start live', 'error');
    }
  };

  const joinLive = async (live: any) => {
    if (!authToken) return;
    setActiveLive(live);
    setIsHost(false);
    axios.post(`/api/live/${live.id}/viewer`, { delta: 1 }, {
      headers: { Authorization: `Bearer ${authToken}` }
    }).catch(() => {});

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: ['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443'], username: 'openrelayproject', credential: 'openrelayproject' }]
      });
      pcRef.current = pc;
      pc.ontrack = (ev) => {
        if (remoteRef.current && ev.streams[0]) {
          remoteRef.current.srcObject = ev.streams[0];
        }
      };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          axios.post('/api/webrtc/signal', {
            roomId: live.id, type: 'ice', candidate: ev.candidate
          }, { headers: { Authorization: `Bearer ${authToken}` } }).catch(() => {});
        }
      };

      signalRef.current = setInterval(async () => {
        try {
          const sRes = await axios.get('/api/webrtc/signal', {
            params: { roomId: live.id },
            headers: { Authorization: `Bearer ${authToken}` }
          });
          for (const s of (sRes.data?.signals || [])) {
            if (s.type === 'offer' && s.sdp && pcRef.current) {
              await pcRef.current.setRemoteDescription(new RTCSessionDescription(s.sdp));
              const answer = await pcRef.current.createAnswer();
              await pcRef.current.setLocalDescription(answer);
              await axios.post('/api/webrtc/signal', {
                roomId: live.id, type: 'answer', sdp: answer, targetUserId: s.fromUserId
              }, { headers: { Authorization: `Bearer ${authToken}` } });
            } else if (s.type === 'ice' && s.candidate && pcRef.current) {
              try { await pcRef.current.addIceCandidate(new RTCIceCandidate(s.candidate)); } catch {}
            }
          }
        } catch {}
      }, 1500);

      pollRef.current = setInterval(async () => {
        try {
          const r = await axios.get(`/api/live/${live.id}`);
          setActiveLive(r.data);
          if (r.data.status !== 'live') {
            onShowToast?.(language === 'so' ? 'Live waa dhammaatay' : 'Live ended', 'success');
            leaveLive();
          }
        } catch {}
      }, 3000);
    } catch (e) {
      console.warn(e);
    }
  };

  const leaveLive = async () => {
    if (activeLive && authToken) {
      if (isHost) {
        await axios.post(`/api/live/${activeLive.id}/end`, {}, {
          headers: { Authorization: `Bearer ${authToken}` }
        }).catch(() => {});
      } else {
        axios.post(`/api/live/${activeLive.id}/viewer`, { delta: -1 }, {
          headers: { Authorization: `Bearer ${authToken}` }
        }).catch(() => {});
      }
    }
    cleanupMedia();
    setActiveLive(null);
    setIsHost(false);
    loadLives();
  };

  useEffect(() => () => cleanupMedia(), []);

  const sendComment = async () => {
    if (!comment.trim() || !activeLive || !authToken) return;
    try {
      const res = await axios.post(`/api/live/${activeLive.id}/comment`, { content: comment }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      setActiveLive(res.data.live);
      setComment('');
    } catch {}
  };

  const react = async (reaction: 'like' | 'love') => {
    if (!activeLive || !authToken) return;
    try {
      const res = await axios.post(`/api/live/${activeLive.id}/react`, { reaction }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      setActiveLive((prev: any) => prev ? { ...prev, likes: res.data.likes, loves: res.data.loves } : prev);
      playNotifByType(reaction);
    } catch {}
  };

  const sendGift = async (g: typeof GIFTS[0]) => {
    if (!activeLive || !authToken) return;
    try {
      await axios.post('/api/gifts/send', {
        toUserId: activeLive.hostId,
        giftId: g.id,
        giftName: g.name,
        coinCost: g.coins,
        liveId: activeLive.id
      }, { headers: { Authorization: `Bearer ${authToken}` } });
      onShowToast?.(language === 'so' ? `Waxaad dirtay ${g.name}` : `Sent ${g.name}`, 'success');
      playNotifByType('gift');
      // show in comments stream
      setActiveLive((prev: any) => prev ? {
        ...prev,
        comments: [...(prev.comments || []), {
          id: `g_${Date.now()}`,
          userName: user?.first_name || 'You',
          content: `🎁 ${g.name}`,
          created_at: new Date().toISOString()
        }]
      } : prev);
    } catch (e: any) {
      onShowToast?.(e?.response?.data?.error || 'Gift failed (top up coins)', 'error');
    }
  };

  if (activeLive) {
    return (
      <div className="bg-black rounded-2xl overflow-hidden relative min-h-[520px] flex flex-col">
        <div className="absolute top-3 left-3 right-3 z-20 flex justify-between items-start">
          <div className="bg-black/60 backdrop-blur rounded-xl px-3 py-2 text-white">
            <div className="flex items-center gap-2 text-xs font-bold">
              <span className="bg-red-600 px-1.5 py-0.5 rounded text-[10px] animate-pulse">LIVE</span>
              <span>{activeLive.hostName}</span>
            </div>
            <div className="text-[10px] text-gray-300 mt-0.5 flex gap-3">
              <span className="flex items-center gap-1"><Eye size={11} /> {activeLive.viewers || 0}</span>
              <span>❤️ {activeLive.likes || 0}</span>
              <span>💕 {activeLive.loves || 0}</span>
            </div>
          </div>
          <button onClick={leaveLive} className="bg-red-600 text-white rounded-full p-2 shadow-lg">
            {isHost ? <PhoneOff size={18} /> : <X size={18} />}
          </button>
        </div>

        <div className="grow relative bg-gray-950 flex items-center justify-center">
          {isHost ? (
            <video ref={localRef} autoPlay muted playsInline className="w-full h-full max-h-[420px] object-cover" />
          ) : (
            <video ref={remoteRef} autoPlay playsInline className="w-full h-full max-h-[420px] object-cover" />
          )}
        </div>

        <div className="absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-3 space-y-2">
          <div className="max-h-28 overflow-y-auto space-y-1 px-1">
            {(activeLive.comments || []).slice(-30).map((c: any) => (
              <div key={c.id} className="text-[11px] text-white/90">
                <span className="font-bold text-amber-300">{c.userName}</span>{' '}
                <span>{c.content}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {GIFTS.map(g => (
              <button key={g.id} onClick={() => sendGift(g)} className="text-[10px] bg-white/10 hover:bg-white/20 text-white rounded-full px-2 py-1 border border-white/10">
                {g.name} · {g.coins}
              </button>
            ))}
          </div>
          <div className="flex gap-2 items-center">
            <button onClick={() => react('like')} className="p-2 rounded-full bg-white/10 text-white"><Heart size={16} /></button>
            <button onClick={() => react('love')} className="p-2 rounded-full bg-pink-600/80 text-white text-xs font-bold px-2">💕</button>
            <input
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendComment()}
              placeholder={language === 'so' ? 'Faallo...' : 'Comment...'}
              className="grow text-xs rounded-full bg-white/10 border border-white/20 text-white px-3 py-2 placeholder-white/40 focus:outline-none"
            />
            <button onClick={sendComment} className="p-2 rounded-full bg-blue-600 text-white"><MessageCircle size={16} /></button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-gradient-to-r from-rose-600 to-orange-500 rounded-2xl p-5 text-white shadow-lg">
        <h2 className="text-xl font-extrabold flex items-center gap-2">
          <Radio size={22} /> {language === 'so' ? 'Live Streaming' : 'Go Live'}
        </h2>
        <p className="text-xs text-white/80 mt-1">
          {language === 'so'
            ? 'Bilow live, dadku way ku daawan karaan, faallo, like, love & hadiyado'
            : 'Start a live stream — viewers can watch, comment, like, love & send gifts'}
        </p>
        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder={language === 'so' ? 'Cinwaanka live...' : 'Live title...'}
            className="grow text-xs rounded-xl px-3 py-2.5 text-gray-900"
          />
          <button
            onClick={startLive}
            className="flex items-center justify-center gap-2 px-5 py-2.5 bg-white text-rose-600 font-bold rounded-xl text-sm shadow"
          >
            <Video size={16} /> {language === 'so' ? 'Bilow Live 🔴' : 'Start Live 🔴'}
          </button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">
          {language === 'so' ? 'Live-yada hadda socda' : 'Live now'}
        </h3>
        {lives.length === 0 ? (
          <div className="text-center py-10 text-gray-400 text-sm border border-dashed border-gray-200 dark:border-gray-700 rounded-2xl">
            {language === 'so' ? 'Ma jiro live hadda. Noqo kan ugu horreeya!' : 'No one is live. Be the first!'}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {lives.map(l => (
              <button
                key={l.id}
                onClick={() => joinLive(l)}
                className="text-left bg-white dark:bg-[#141b2d] border border-gray-100 dark:border-gray-800 rounded-2xl p-4 hover:shadow-md transition-all"
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-rose-500 to-orange-400 flex items-center justify-center text-white font-black relative">
                    {(l.hostName || 'L')[0]}
                    <span className="absolute -bottom-1 -right-1 bg-red-600 text-[8px] px-1 rounded font-bold">LIVE</span>
                  </div>
                  <div>
                    <div className="font-bold text-sm text-gray-900 dark:text-white">{l.title}</div>
                    <div className="text-[11px] text-gray-500">{l.hostName} · 👁 {l.viewers || 0}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
