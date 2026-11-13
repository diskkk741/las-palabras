"""Fiil çekim tablosu üretir: conj.json
Kaynak: words.json + tags.json içindeki mastarlar (etiketi v./v. prnl. olan ya da başka bir kelimenin mastarı olarak geçenler).
4 zaman (presente, pretérito indefinido, imperfecto, futuro) × 5 kişi (yo, tú, él/ella, nosotros, ellos).
vosotros/vos yok: Duolingo'nun bu kursu Latin Amerika İspanyolcası öğretiyor.
Kütüphanenin şablonlarında olmayan (tahmin edilen) fiiller atlanır; hatalı çekim öğretmektense hiç sormamak iyidir.
Sadece eksik fiiller eklenir; mevcut kayıtlara dokunulmaz.  Kullanım: pip install verbecc && python scripts/conj.py"""
import json, os, re, sys, logging
logging.disable(logging.CRITICAL)
from verbecc import CompleteConjugator

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
TENSES = {'pres': 'presente', 'pret': 'pretérito-perfecto-simple', 'imp': 'pretérito-imperfecto', 'fut': 'futuro'}
PERSONS = ['yo', 'tú', 'él', 'nosotros', 'ellos']
# kişisiz / yardımcı kullanılan fiiller: "yo duelo", "yo llovo" gibi sorular kafa karıştırır
EXCLUDE = {'doler', 'llover', 'nevar', 'encantar', 'fascinar', 'importar', 'faltar', 'haber', 'gustar', 'parecer'}

def infinitives(words, tags):
    out = set()
    for w in words:
        t = tags.get(w[0], {})
        if t.get('l'): out.add(t['l'])
        elif str(t.get('t', '')).startswith('v.') and re.fullmatch(r'[a-záéíóúñ]+(ar|er|ir|ír)(se)?', w[0]): out.add(w[0])
    return sorted(out)

def conjugate(cg, inf):
    r = json.loads(cg.conjugate(inf).to_json())
    if r.get('verb', r.get('verb_info', {})).get('predicted'): return None
    ind = r['moods']['indicativo']
    res = {}
    for key, name in TENSES.items():
        row = []
        for p in PERSONS:
            hit = next((x for x in ind[name] if x.get('pr') == p), None)
            if not hit: return None
            form = hit['c'][0]
            form = re.sub(r'^' + p + r'\s+', '', form)          # "yo como" → "como" ; dönüşlülerde "me levanto" kalır
            row.append(form)
        res[key] = row
    return res

def main():
    words = json.load(open(os.path.join(ROOT, 'words.json'), encoding='utf-8'))['words']
    tags = json.load(open(os.path.join(ROOT, 'tags.json'), encoding='utf-8'))
    path = os.path.join(ROOT, 'conj.json')
    conj = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
    cg = CompleteConjugator(lang='es')
    added, skipped = 0, []
    for inf in infinitives(words, tags):
        if inf in conj or inf in EXCLUDE or ' ' in inf: continue
        try: c = conjugate(cg, inf)
        except Exception: c = None
        if c: conj[inf] = c; added += 1
        else: skipped.append(inf)
    for x in EXCLUDE: conj.pop(x, None)
    json.dump(conj, open(path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    print(f'conj.json: {len(conj)} fiil (+{added}). Atlanan: {", ".join(skipped) or "-"}')

if __name__ == '__main__':
    main()
