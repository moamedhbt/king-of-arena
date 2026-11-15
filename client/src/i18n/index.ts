import ar from './ar.json';
import en from './en.json';

type Dict = Record<string, string>;
const dicts: Record<string, Dict> = { ar: ar as Dict, en: en as Dict };
let lang: string = (localStorage.getItem('koa_lang') as string) || 'ar';

export function setLang(l: string) {
  lang = dicts[l] ? l : 'ar';
  localStorage.setItem('koa_lang', lang);
}
export function getLang() {
  return lang;
}

/** ترجمة بسيطة: t('key', {n: 3}) — تعود للمفتاح نفسه إن لم يوجد */
export function t(key: string, vars?: Record<string, string | number>): string {
  const d = dicts[lang] ?? dicts.ar;
  let s = d[key] ?? dicts.ar[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export default t;
