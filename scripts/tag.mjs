// Yeni kelimeleri yapay zekâyla etiketler ve örnek cümle üretir (GitHub Models, ücretsiz;
// GITHUB_TOKEN + workflow'da "models: read" izni).
//  1) words.json'da olup tags.json'da olmayan kelimeler → tags.json:
//       t: kelime türü (RAE kısaltması)   l: çekimli fiilse mastarı   b: düzgün Türkçe karşılık
//     ve examples.json: [kısa İspanyolca örnek cümle, Türkçesi]
//  2) Etiketi olup örneği olmayan eski kelimeler → her çalıştırmada en fazla MAX_EX tanesine örnek cümle.
// Cevaplar katı biçimde doğrulanır; geçersiz satır atlanır (bir sonraki çalıştırmada yeniden denenir).
// Servis yanıt vermezse iş başarısız olmaz: kelimeler yine eklenir, etiket/örnekler sonra tamamlanır.

import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const ENDPOINT = process.env.MODELS_URL || 'https://models.github.ai/inference/chat/completions';
const MODELS = (process.env.MODELS || 'openai/gpt-4.1-mini,openai/gpt-4o-mini,openai/gpt-4o').split(',');
const BATCH = 25;
const MAX_TAG = 300;
const MAX_EX = +(process.env.MAX_EX || 300);
const PAUSE = +(process.env.PAUSE_MS ?? 4000);      // ücretsiz katmanın dakika sınırına takılmamak için

export const ALLOWED = new Set(['m.', 'f.', 'm./f.', 'm. pl.', 'f. pl.', 'adj.', 'v.', 'v. prnl.', 'part.', 'adv.',
  'prep.', 'conj.', 'pron.', 'det.', 'art.', 'contr.', 'num.', 'interr.', 'interj.', 'loc.']);

const EX_RULES = `- "x": kelimeyi AYNEN bu yazılışıyla içeren, B1 seviyesinde, doğal, kısa (4–9 kelime) bir İspanyolca cümle. Latin Amerika İspanyolcası; vosotros kullanma.
- "xt": bu cümlenin doğal Türkçe çevirisi.`;

const SYSTEM_TAG = `Sen bir İspanyolca–Türkçe sözlük editörüsün. Duolingo'nun Türkçe konuşanlar için İspanyolca kursundan gelen kelimeleri etiketliyorsun.
Her kelime için JSON nesnesi döndür:
- "t": kelime türü, SADECE şu listeden biri: ${[...ALLOWED].join(', ')}
  · isimlerde cinsiyet: m. (eril), f. (dişil), m./f. (iki cinsiyetli, ör. estudiante), çoğulsa "m. pl." / "f. pl."
  · fiil mastarı: "v." ; -se ile biten dönüşlü mastar: "v. prnl." ; çekimli fiil: "v." ; geçmiş zaman ortacı (-ado/-ido, hecho, dicho, visto...) fiilimsi olarak kullanılıyorsa "part.", sıfatsa "adj."
  · birden fazla kelimelik kalıp ifade: "loc." (ama "fin de semana" gibi bileşik isimler isim türünü alır)
- "l": kelime ÇEKİMLİ bir fiil ya da ortaçsa mastarı (ör. "hirvió" → "hervir", "dicho" → "decir"); değilse "".
- "b": en doğal Türkçe karşılık, sözlük biçiminde ve kısa (en fazla 4 kelime). Mastar → "-mek/-mak" (convertir → "dönüştürmek"); çekimli fiil → aynı kişi ve zamanda (hirvió → "kaynattı", advierto → "uyarırım"); isim/sıfat → yalın hal (pecho → "göğüs"). Duolingo'nun verdiği karşılık zaten doğru ve yalın haldeyse aynen yaz.
${EX_RULES}
Sadece şu biçimde JSON döndür: {"items":[{"es":"...","t":"...","l":"...","b":"...","x":"...","xt":"..."}]} — giriş sırasıyla, her kelime için bir nesne, başka metin yok.`;

const SYSTEM_EX = `Sen bir İspanyolca öğretmenisin. Duolingo'nun Türkçe konuşanlar için İspanyolca kursundan gelen her kelime için bir örnek cümle yaz.
${EX_RULES}
Sadece şu biçimde JSON döndür: {"items":[{"es":"...","x":"...","xt":"..."}]} — giriş sırasıyla, her kelime için bir nesne, başka metin yok.`;

export function validate(item, word) {
  if (!item || item.es !== word.es) return null;
  const t = String(item.t || '').trim();
  if (!ALLOWED.has(t)) return null;
  const out = { t };
  const l = String(item.l || '').trim();
  if (l && l !== word.es && /^[a-záéíóúüñ]+(se)?$/i.test(l) && l.length <= 25 && /(ar|er|ir|ír|arse|erse|irse|írse)$/i.test(l)) out.l = l;
  const b = String(item.b || '').trim();
  if (b && b.length <= 45 && b.split(/\s+/).length <= 6 && b.toLocaleLowerCase('tr') !== String(word.tr).toLocaleLowerCase('tr')) out.b = b;
  out.ai = 1;
  return out;
}
const fold = s => s.toLowerCase().normalize('NFC');
export function validateEx(item, word) {
  if (!item || item.es !== word.es) return null;
  const x = String(item.x || '').trim(), xt = String(item.xt || '').trim();
  if (!x || !xt || x.length > 90 || xt.length > 110 || x.split(/\s+/).length > 14) return null;
  if (!fold(x).includes(fold(word.es))) return null;                  // cümle kelimenin kendisini içermeli
  if (/\bvosotr|\bos\b/i.test(x)) return null;
  return [x, xt];
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

let preferred = null; // bir kez çalışan model sonraki gruplarda önce denenir
export async function ask(system, payload, { token, fetchImpl = fetch, log = console.log } = {}) {
  const order = preferred ? [preferred, ...MODELS.filter(m => m !== preferred)] : MODELS;
  const user = JSON.stringify(payload);
  let lastErr;
  for (const model of order) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (r.ok) {
        const j = await r.json();
        const data = parseJSON(j.choices?.[0]?.message?.content || '');
        if (data && Array.isArray(data.items)) { preferred = model; return { model, items: data.items }; }
        lastErr = new Error(`${model}: geçersiz JSON`);
        break;
      }
      lastErr = new Error(`${model}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 15000 * attempt)); continue; }
      break; // 400/401/403/404: bu model olmuyor, sıradakini dene
    }
    log(`uyarı: ${lastErr.message}`);
  }
  throw lastErr;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function run({ token, fetchImpl, log = console.log } = {}) {
  const words = JSON.parse(await readFile(new URL('words.json', ROOT), 'utf8')).words;
  const tagsPath = new URL('tags.json', ROOT), exPath = new URL('examples.json', ROOT);
  const tags = JSON.parse(await readFile(tagsPath, 'utf8'));
  let ex = {}; try { ex = JSON.parse(await readFile(exPath, 'utf8')); } catch {}
  const all = words.map(w => ({ es: w[0], tr: (tags[w[0]] && tags[w[0]].b) || w[1], alt: w[2], unit: w[5] }));
  const opt = { token, fetchImpl, log };
  let tagged = 0, exAdded = 0, skipped = 0, failed = false;

  // 1) etiketsiz kelimeler: etiket + örnek
  const todo = all.filter(w => !tags[w.es]).slice(0, MAX_TAG);
  if (todo.length) log(`${todo.length} yeni kelime etiketlenecek.`);
  for (let i = 0; i < todo.length && !failed; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      const res = await ask(SYSTEM_TAG, batch.map(w => ({ es: w.es, duolingo: w.tr, alternatifler: w.alt || '', unite: w.unit || '' })), opt);
      const byEs = new Map(res.items.filter(x => x && x.es).map(x => [x.es, x]));
      for (const w of batch) {
        const v = validate(byEs.get(w.es), w);
        if (v) { tags[w.es] = v; tagged++; } else skipped++;
        const e = validateEx(byEs.get(w.es), w);
        if (e) { ex[w.es] = e; exAdded++; }
      }
      log(`[${res.model}] etiket ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    } catch (e) { log(`::warning::Etiketleme yapılamadı: ${e.message}`); failed = true; }
    if (PAUSE) await sleep(PAUSE);
  }

  // 2) örneği olmayan eski kelimeler (yavaş yavaş doldurulur)
  const exTodo = failed ? [] : all.filter(w => tags[w.es] && !ex[w.es]).slice(0, MAX_EX);
  if (exTodo.length) log(`${exTodo.length} kelimeye örnek cümle yazılacak (kalan: ${all.filter(w => !ex[w.es]).length}).`);
  for (let i = 0; i < exTodo.length; i += BATCH) {
    const batch = exTodo.slice(i, i + BATCH);
    try {
      const res = await ask(SYSTEM_EX, batch.map(w => ({ es: w.es, anlam: w.tr })), opt);
      const byEs = new Map(res.items.filter(x => x && x.es).map(x => [x.es, x]));
      for (const w of batch) { const e = validateEx(byEs.get(w.es), w); if (e) { ex[w.es] = e; exAdded++; } }
      log(`[${res.model}] örnek ${Math.min(i + BATCH, exTodo.length)}/${exTodo.length}`);
    } catch (e) { log(`::warning::Örnek cümle yazılamadı: ${e.message}`); failed = true; break; }
    if (PAUSE) await sleep(PAUSE);
  }

  if (tagged) await writeFile(tagsPath, JSON.stringify(tags));
  if (exAdded) await writeFile(exPath, JSON.stringify(ex));
  log(`Etiketlendi: ${tagged}, örnek cümle: ${exAdded}, atlandı: ${skipped}${failed ? ' (servis hatası, kalanlar sonra denenecek)' : ''}.`);
  return { tagged, exAdded, skipped, failed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!token) { console.log('::warning::GITHUB_TOKEN yok, etiketleme atlandı.'); process.exit(0); }
  await run({ token });
}
