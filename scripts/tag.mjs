// Yeni kelimeleri yapay zekâyla etiketler (GitHub Models, ücretsiz; GITHUB_TOKEN + "models: read" izni).
// words.json'da olup tags.json'da olmayan her kelime için:
//   t: kelime türü (RAE kısaltması)   l: çekimli fiilse mastarı   b: düzgün Türkçe karşılık
// Cevap katı biçimde doğrulanır; geçersiz satır atlanır (o kelime bir sonraki çalıştırmada tekrar denenir).
// Servis yanıt vermezse iş başarısız olmaz: kelimeler yine eklenir, sadece etiketler bekler.

import { readFile, writeFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const ENDPOINT = process.env.MODELS_URL || 'https://models.github.ai/inference/chat/completions';
const MODELS = (process.env.MODELS || 'openai/gpt-4.1-mini,openai/gpt-4o-mini,openai/gpt-4o').split(',');
const BATCH = 25;
const MAX_PER_RUN = 300;

export const ALLOWED = new Set(['m.', 'f.', 'm./f.', 'm. pl.', 'f. pl.', 'adj.', 'v.', 'v. prnl.', 'part.', 'adv.',
  'prep.', 'conj.', 'pron.', 'det.', 'art.', 'contr.', 'num.', 'interr.', 'interj.', 'loc.']);

const SYSTEM = `Sen bir İspanyolca–Türkçe sözlük editörüsün. Duolingo'nun Türkçe konuşanlar için İspanyolca kursundan gelen kelimeleri etiketliyorsun.
Her kelime için JSON nesnesi döndür:
- "t": kelime türü, SADECE şu listeden biri: ${[...ALLOWED].join(', ')}
  · isimlerde cinsiyet: m. (eril), f. (dişil), m./f. (iki cinsiyetli, ör. estudiante), çoğulsa "m. pl." / "f. pl."
  · fiil mastarı: "v." ; -se ile biten dönüşlü mastar: "v. prnl." ; çekimli fiil: "v." ; geçmiş zaman ortacı (-ado/-ido, hecho, dicho, visto...) fiilimsi olarak kullanılıyorsa "part.", sıfatsa "adj."
  · birden fazla kelimelik kalıp ifade: "loc." (ama "fin de semana" gibi bileşik isimler isim türünü alır)
- "l": kelime ÇEKİMLİ bir fiil ya da ortaçsa mastarı (ör. "hirvió" → "hervir", "dicho" → "decir"); değilse "".
- "b": en doğal Türkçe karşılık, sözlük biçiminde ve kısa (en fazla 4 kelime). Mastar → "-mek/-mak" (convertir → "dönüştürmek"); çekimli fiil → aynı kişi ve zamanda (hirvió → "kaynattı", advierto → "uyarırım"); isim/sıfat → yalın hal (pecho → "göğüs"). Duolingo'nun verdiği karşılık zaten doğru ve yalın haldeyse aynen yaz.
Sadece şu biçimde JSON döndür: {"items":[{"es":"...","t":"...","l":"...","b":"..."}]} — giriş sırasıyla, her kelime için bir nesne, başka metin yok.`;

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

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

let preferred = null; // bir kez çalışan model sonraki gruplarda önce denenir
export async function tagBatch(words, { token, fetchImpl = fetch, log = console.log } = {}) {
  const order = preferred ? [preferred, ...MODELS.filter(m => m !== preferred)] : MODELS;
  const user = JSON.stringify(words.map(w => ({ es: w.es, duolingo: w.tr, alternatifler: w.alt || '', unite: w.unit || '' })));
  let lastErr;
  for (const model of order) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
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

export async function run({ token, fetchImpl, log = console.log } = {}) {
  const words = JSON.parse(await readFile(new URL('words.json', ROOT), 'utf8')).words;
  const tagsPath = new URL('tags.json', ROOT);
  const tags = JSON.parse(await readFile(tagsPath, 'utf8'));
  const todo = words.filter(w => !tags[w[0]])
    .map(w => ({ es: w[0], tr: w[1], alt: w[2], unit: w[5] }))
    .slice(0, MAX_PER_RUN);
  if (!todo.length) { log('Etiketlenecek yeni kelime yok.'); return { added: 0 }; }
  log(`${todo.length} yeni kelime etiketlenecek.`);
  let added = 0, skipped = 0, failed = false;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    let res;
    try { res = await tagBatch(batch, { token, fetchImpl, log }); }
    catch (e) { log(`::warning::Etiketleme yapılamadı: ${e.message}`); failed = true; break; }
    const byEs = new Map(res.items.filter(x => x && x.es).map(x => [x.es, x]));
    for (const w of batch) {
      const v = validate(byEs.get(w.es), w);
      if (v) { tags[w.es] = v; added++; } else skipped++;
    }
    log(`[${res.model}] ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
  }
  if (added) await writeFile(tagsPath, JSON.stringify(tags));
  log(`Etiketlendi: ${added}, atlandı: ${skipped}${failed ? ' (servis hatası, kalanlar sonra denenecek)' : ''}.`);
  return { added, skipped, failed };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!token) { console.log('::warning::GITHUB_TOKEN yok, etiketleme atlandı.'); process.exit(0); }
  await run({ token });
}
