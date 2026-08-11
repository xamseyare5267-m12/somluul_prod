import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useLanguage } from './LanguageContext.js';
import { Flag, Plus, Users, Search } from 'lucide-react';

interface Props {
  user?: any;
  authToken?: string;
  onShowToast?: (m: string, t: 'success' | 'error') => void;
  onViewProfile?: (id: string) => void;
}

/** Facebook-style public Pages — create, browse, follow */
export const PagesSection: React.FC<Props> = ({ user, authToken, onShowToast }) => {
  const { language } = useLanguage();
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Business');
  const [description, setDescription] = useState('');
  const [username, setUsername] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/pages', { params: q ? { q } : {} });
      setPages(Array.isArray(res.data) ? res.data : []);
    } catch {
      setPages([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) {
      onShowToast?.(language === 'so' ? 'Fadlan soo gal' : 'Please log in', 'error');
      return;
    }
    try {
      await axios.post('/api/pages', { name, category, description, username }, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setShowCreate(false);
      setName(''); setDescription(''); setUsername('');
      onShowToast?.(language === 'so' ? 'Page waa la sameeyay' : 'Page created', 'success');
      load();
    } catch (err: any) {
      onShowToast?.(err?.response?.data?.error || 'Failed', 'error');
    }
  };

  const handleFollow = async (pageId: string) => {
    if (!authToken) return;
    try {
      const res = await axios.post(`/api/pages/${pageId}/follow`, {}, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      setPages(prev => prev.map(p => p.id === pageId ? { ...p, ...res.data.page, followersCount: res.data.followersCount } : p));
    } catch (err: any) {
      onShowToast?.(err?.response?.data?.error || 'Failed', 'error');
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-black text-gray-900 dark:text-white flex items-center gap-2">
            <Flag className="text-blue-600" size={22} />
            {language === 'so' ? 'SomLuul Pages' : 'SomLuul Pages'}
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            {language === 'so'
              ? 'Pages shirkadaha, dadka caanka ah, iyo bulshooyinka — sida Facebook Pages.'
              : 'Pages for businesses, public figures, and communities — like Facebook Pages.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-bold"
        >
          <Plus size={16} /> {language === 'so' ? 'Samee Page' : 'Create Page'}
        </button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
          placeholder={language === 'so' ? 'Raadi pages...' : 'Search pages...'}
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-[#141b2d] text-sm text-gray-900 dark:text-white"
        />
      </div>

      {loading ? (
        <p className="text-center text-sm text-gray-500 py-10">Loading...</p>
      ) : pages.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-[#141b2d] rounded-2xl border border-gray-100 dark:border-gray-800">
          <Flag className="mx-auto text-gray-300 mb-2" size={40} />
          <p className="text-sm text-gray-500">
            {language === 'so' ? 'Weli pages ma jiraan. Samee midkaaga!' : 'No pages yet. Create yours!'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {pages.map(page => (
            <div key={page.id} className="bg-white dark:bg-[#141b2d] border border-gray-100 dark:border-gray-800 rounded-2xl p-4 flex gap-3 items-center">
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-700 text-white flex items-center justify-center font-black text-lg shrink-0 overflow-hidden">
                {page.avatar ? (
                  <img src={page.avatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  (page.name || 'P')[0].toUpperCase()
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-bold text-gray-900 dark:text-white truncate">{page.name}</h3>
                <p className="text-xs text-gray-500 truncate">@{page.username} · {page.category}</p>
                <p className="text-[11px] text-gray-400 flex items-center gap-1 mt-0.5">
                  <Users size={12} /> {page.followersCount || 0} {language === 'so' ? 'followers' : 'followers'}
                </p>
                {page.description && <p className="text-xs text-gray-600 dark:text-gray-400 mt-1 line-clamp-2">{page.description}</p>}
              </div>
              <button
                type="button"
                onClick={() => handleFollow(page.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700 shrink-0"
              >
                {language === 'so' ? 'Follow' : 'Follow'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <form
            onSubmit={handleCreate}
            onClick={e => e.stopPropagation()}
            className="bg-white dark:bg-[#141b2d] rounded-2xl p-5 w-full max-w-md space-y-3 shadow-2xl"
          >
            <h3 className="font-black text-gray-900 dark:text-white">{language === 'so' ? 'Samee Page cusub' : 'Create a Page'}</h3>
            <input required value={name} onChange={e => setName(e.target.value)} placeholder={language === 'so' ? 'Magaca page-ka' : 'Page name'} className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1f293d] text-gray-900 dark:text-white" />
            <input value={username} onChange={e => setUsername(e.target.value)} placeholder="username (optional)" className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1f293d] text-gray-900 dark:text-white" />
            <select value={category} onChange={e => setCategory(e.target.value)} className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1f293d] text-gray-900 dark:text-white">
              {['Business', 'Public Figure', 'Brand', 'Community', 'Entertainment', 'News', 'Education', 'Other'].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <textarea value={description} onChange={e => setDescription(e.target.value)} placeholder={language === 'so' ? 'Sharaxaad' : 'Description'} rows={3} className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1f293d] text-gray-900 dark:text-white" />
            <div className="flex gap-2">
              <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-2 rounded-xl text-xs font-bold bg-gray-100 dark:bg-gray-800">Cancel</button>
              <button type="submit" className="flex-1 py-2 rounded-xl text-xs font-bold bg-blue-600 text-white">Create</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
