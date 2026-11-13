// Duolingo → words.json senkronu (GitHub Actions'ta her pazartesi çalışır, elle de çalıştırılabilir).
// Gerekli ortam değişkeni: DUO_JWT  (duolingo.com'daki jwt_token çerezi; repo secret olarak saklanır)
// Çıktı: repo kökünde words.json — uygulama açılışta bunu okuyup yeni kelimeleri ekler.
// Başladığın (yarım kalan) ünitelerin o ana kadar öğrendiğin kelimeleri de dahildir.
// Node 20+ (yerleşik fetch ve atob), ek paket gerekmez.

import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../words.json', import.meta.url);
const LEARN = 'es', FROM = 'tr';

// prev: önceki words.json. Varsa ve ses bilgisi içeriyorsa ARTIMLI çalışır: sadece en son kayıtlı ünite ve
// sonrası sorgulanır (~3 istek). İlk çalıştırmada, ses bilgisi yokken ya da full=true iken TAM tarama (~130 istek).
export async function collect(jwt, { fetchImpl = fetch, log = console.log, base = 'https://www.duolingo.com', prev = null, full = false } = {}) {
  const uid = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
  const H = {
    Authorization: 'Bearer ' + jwt,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getJSON = async (url, opt = {}) => {
    for (let attempt = 1; ; attempt++) {
      const r = await fetchImpl(base + url, { headers: H, ...opt });
      if (r.ok) return r.json();
      if (r.status === 401 || r.status === 403) throw new Error(`Yetki hatası (HTTP ${r.status}): DUO_JWT geçersiz ya da süresi dolmuş.`);
      if (attempt >= 3) throw new Error(`HTTP ${r.status}: ${url}`);
      await sleep(2000 * attempt);
    }
  };

  const { currentCourse: cc } = await getJSON(`/2017-06-30/users/${uid}?fields=currentCourse`);
  if (cc.learningLanguage !== LEARN || cc.fromLanguage !== FROM)
    throw new Error(`Aktif kurs ${cc.fromLanguage}→${cc.learningLanguage}; script ${FROM}→${LEARN} için ayarlı.`);

  // ünite → başlanmış/bitmiş skill seviyeleri (yarım kalan seviyeler de sayılır)
  const units = []; let unitNo = 0;
  for (const sec of cc.pathSectioned) {
    let local = 0;
    for (const u of sec.units || []) {
      unitNo++; local++;
      const skills = new Map();
      for (const l of u.levels || []) {
        const sid = l.pathLevelMetadata?.skillId;
        if (!sid || l.type !== 'skill') continue;
        const crown = l.pathLevelMetadata.crownLevelIndex || 0;
        const p = skills.get(sid) || { finishedLevels: 0, finishedSessions: 0, skillId: { id: sid } };
        if (l.state === 'passed' || l.state === 'legendary') p.finishedLevels = Math.max(p.finishedLevels, crown + 1);
        else if (l.finishedSessions > 0) {
          p.finishedLevels = Math.max(p.finishedLevels, crown);
          p.finishedSessions = Math.max(p.finishedSessions, l.finishedSessions);
        }
        if (p.finishedLevels > 0 || p.finishedSessions > 0) skills.set(sid, p);
      }
      if (skills.size) units.push({ no: unitNo, sec: sec.index + 1, local, title: u.teachingObjective || '', skills });
    }
  }

  async function lexemes(progressedSkills) {
    const out = []; let start = 0;
    while (start != null) {
      const j = await getJSON(
        `/2017-06-30/users/${uid}/courses/${LEARN}/${FROM}/learned-lexemes?limit=1000&sortBy=LEARNED_DATE&startIndex=${start}`,
        { method: 'POST', body: JSON.stringify({ lastTotalLexemeCount: 0, progressedSkills }) });
      out.push(...j.learnedLexemes);
      start = j.pagination?.nextStartIndex ?? null;
      await sleep(300);
    }
    return out;
  }

  const prevWords = prev && Array.isArray(prev.words) ? prev.words : [];
  const prevMax = Math.max(0, ...prevWords.map(w => w[6]).filter(n => n < 9999));
  const incremental = !full && prevWords.length && prevMax && prevWords.every(w => w.length >= 8);
  const scan = incremental ? units.filter(u => u.no >= prevMax) : units;
  log(incremental ? `Artımlı tarama: ${scan.length} ünite (kayıtlı son ünite #${prevMax} ve sonrası)` : `Tam tarama: ${scan.length} ünite`);

  // her kelime ilk göründüğü üniteye atanır
  const known = new Set(prevWords.map(w => w[0]));
  const words = new Map();
  for (const u of scan) {
    log(`Ünite ${u.no}/${unitNo}`);
    for (const lx of await lexemes([...u.skills.values()]))
      if (!words.has(lx.text) && !(incremental && known.has(lx.text))) words.set(lx.text, { tr: lx.translations, audio: lx.audioURL, unit: u });
  }
  if (!incremental) {
    const all = new Map();
    for (const u of units) for (const [k, v] of u.skills) {
      const p = all.get(k);
      if (!p || v.finishedLevels > p.finishedLevels || (v.finishedLevels === p.finishedLevels && v.finishedSessions > p.finishedSessions)) all.set(k, v);
    }
    for (const lx of await lexemes([...all.values()]))
      if (!words.has(lx.text)) words.set(lx.text, { tr: lx.translations, audio: lx.audioURL, unit: null });
  }

  // ana karşılık: ilk öneri; ilk önerinin başı olan daha kısa bir karşılık varsa o (aspirini → aspirin)
  const clean = s => s.normalize('NFC').replace(/i̇/g, 'i').trim();
  const pickMain = (es, list) => {
    const lower = es === es.toLocaleLowerCase('es');
    const tr = [...new Set(list.map(clean).filter(Boolean).map(t => lower ? t.toLocaleLowerCase('tr') : t))];
    if (!tr.length) return { main: '', rest: [] };
    let main = tr[0];
    for (const t of tr) if (t.length >= 2 && t.length < main.length && tr[0].startsWith(t)) main = t;
    return { main, rest: tr.filter(t => t !== main) };
  };
  const fresh = [...words].map(([es, w]) => {
    const { main, rest } = pickMain(es, w.tr);
    // [ispanyolca, türkçe, alternatifler, kısım, ünite(kısım içi), ünite başlığı, global ünite sırası, ses URL]
    return [es, main, rest.slice(0, 3).join(', '), w.unit?.sec ?? 0, w.unit?.local ?? 0, w.unit?.title ?? '', w.unit?.no ?? 9999, w.audio || ''];
  });
  const list = (incremental ? [...prevWords, ...fresh] : fresh).sort((a, b) => a[6] - b[6] || a[0].localeCompare(b[0], 'es'));

  const cur = units.length ? units[units.length - 1] : null;
  return { course: `${FROM}-${LEARN}`, lastUnit: cur ? { sec: cur.sec, no: cur.local, title: cur.title } : null, words: list };
}

// ---- komut satırı ----
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const jwt = (process.env.DUO_JWT || '').trim();
  if (!jwt) { console.error('DUO_JWT tanımlı değil.'); process.exit(1); }
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  // her ayın ilk pazartesisi tam tarama: Duolingo'nun eski ünitelerde yaptığı değişiklikler de yakalansın
  const full = process.env.FULL === '1' || new Date().getUTCDate() <= 7;
  const data = await collect(jwt, { prev, full });
  const same = prev && JSON.stringify(prev.words) === JSON.stringify(data.words);
  if (same) { console.log(`Değişiklik yok (${data.words.length} kelime).`); process.exit(0); }
  const added = prev ? data.words.length - prev.words.length : data.words.length;
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), count: data.words.length, ...data }) + '\n');
  console.log(`words.json yazıldı: ${data.words.length} kelime (${added >= 0 ? '+' : ''}${added}).`);
}
