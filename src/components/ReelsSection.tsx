import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Heart, MessageCircle, Share2, Volume2, VolumeX, ChevronUp, ChevronDown } from 'lucide-react';
import { useLanguage } from './LanguageContext.js';

interface Props {
  user?: any;
  authToken?: string;
  onShowToast?: (m: string, t: 'success' | 'error') => void;
  onViewProfile?: (id: string) => void;
}

/**
 * Short-video / Reels experience — vertical cards driven by real video posts.
 * Autoplay when in view; no fake streams.
 */
export const ReelsSection: React.FC<Props> = ({ user, authToken, onShowToast, onViewProfile }) => {
  const { language } = useLanguage();
  const [reels, setReels] = useState<any[]>([]);
  const [index, setIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  const [loading, setLoading] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await axios.get('/api/posts', {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
          params: { page: 1, limit: 50 }
        });
        // Server returns { data: Post[], hasMore } — also accept legacy array
        const raw = res.data;
        const all: any[] = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.data)
            ? raw.data
            : Array.isArray(raw?.posts)
              ? raw.posts
              : [];
        const videos = all.filter((p: any) => {
          if (p.mediaType === 'video' && p.mediaUrl) return true;
          if (Array.isArray(p.mediaList) && p.mediaList.some((m: any) => m.type === 'video')) return true;
          return false;
        }).map((p: any) => {
          const videoUrl = p.mediaType === 'video'
            ? p.mediaUrl
            : (p.mediaList?.find((m: any) => m.type === 'video')?.url || p.mediaUrl);
          return { ...p, videoUrl };
        });
        setReels(videos);
        setIndex(0);
      } catch {
        setReels([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [authToken]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.load();
    v.play().catch(() => {});
  }, [index, reels]);

  const current = reels[index];

  const go = (dir: 1 | -1) => {
    if (!reels.length) return;
    setIndex((i) => (i + dir + reels.length) % reels.length);
  };

  const react = async (type: 'like' | 'love') => {
    if (!current || !authToken) return;
    try {
      const res = await axios.post(`/api/posts/${current.id}/like`, { type }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      setReels((prev) => prev.map((r, i) => (i === index ? { ...r, ...res.data, videoUrl: r.videoUrl } : r)));
    } catch {
      onShowToast?.(language === 'so' ? 'Reaction way fashilantay' : 'Reaction failed', 'error');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] text-sm text-gray-500">
        Loading Reels…
      </div>
    );
  }

  if (!reels.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3 px-6 text-center">
        <div className="text-4xl">🎬</div>
        <p className="text-sm font-bold text-gray-700 dark:text-gray-200">
          {language === 'so' ? 'Weli muqaal gaaban (Reels) ma jiro' : 'No short videos yet'}
        </p>
        <p className="text-xs text-gray-500 max-w-sm">
          {language === 'so'
            ? 'Soo gali post video ah Feed-ka si uu halkan ugu muuqdo.'
            : 'Upload a video post on the Feed and it will appear here.'}
        </p>
      </div>
    );
  }

  return (
    <div className="relative mx-auto max-w-md w-full h-[min(78vh,720px)] bg-black rounded-2xl overflow-hidden shadow-2xl">
      <video
        ref={videoRef}
        key={current.id + String(index)}
        src={current.videoUrl}
        className="absolute inset-0 w-full h-full object-contain bg-black"
        playsInline
        loop
        muted={muted}
        autoPlay
        controls={false}
      />

      {/* Gradient overlays */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/80 to-transparent pointer-events-none" />

      {/* Side actions */}
      <div className="absolute right-3 bottom-28 flex flex-col items-center gap-4 z-10">
        <button type="button" onClick={() => react('like')} className="flex flex-col items-center text-white">
          <span className="w-11 h-11 rounded-full bg-white/15 backdrop-blur flex items-center justify-center">
            <Heart size={22} className={current.isLiked || current.myReaction === 'like' ? 'fill-blue-400 text-blue-400' : ''} />
          </span>
          <span className="text-[10px] font-bold mt-1">{current.likes || 0}</span>
        </button>
        <button type="button" onClick={() => react('love')} className="flex flex-col items-center text-white">
          <span className="w-11 h-11 rounded-full bg-white/15 backdrop-blur flex items-center justify-center text-lg">❤️</span>
        </button>
        <button
          type="button"
          onClick={() => {
            const url = `${window.location.origin}/?tab=feed`;
            navigator.clipboard?.writeText(url);
            onShowToast?.(language === 'so' ? 'Link waa la koobiyeeyay' : 'Link copied', 'success');
          }}
          className="flex flex-col items-center text-white"
        >
          <span className="w-11 h-11 rounded-full bg-white/15 backdrop-blur flex items-center justify-center">
            <Share2 size={20} />
          </span>
        </button>
        <button type="button" onClick={() => setMuted((m) => !m)} className="flex flex-col items-center text-white">
          <span className="w-11 h-11 rounded-full bg-white/15 backdrop-blur flex items-center justify-center">
            {muted ? <VolumeX size={20} /> : <Volume2 size={20} />}
          </span>
        </button>
      </div>

      {/* Caption */}
      <div className="absolute left-4 right-20 bottom-6 z-10 text-white space-y-1">
        <button
          type="button"
          className="text-sm font-bold hover:underline"
          onClick={() => current.author?.id && onViewProfile?.(current.author.id)}
        >
          @{current.author?.handle || current.author?.name || 'user'}
        </button>
        <p className="text-xs text-white/90 line-clamp-3 whitespace-pre-wrap">{current.content}</p>
        <p className="text-[10px] text-white/50">{index + 1} / {reels.length}</p>
      </div>

      {/* Up / Down */}
      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex flex-col gap-2 z-10">
        <button type="button" onClick={() => go(-1)} className="w-9 h-9 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/60">
          <ChevronUp size={20} />
        </button>
        <button type="button" onClick={() => go(1)} className="w-9 h-9 rounded-full bg-black/40 text-white flex items-center justify-center hover:bg-black/60">
          <ChevronDown size={20} />
        </button>
      </div>
    </div>
  );
};

export default ReelsSection;
