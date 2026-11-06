const pad2 = (n: number) => String(n).padStart(2, '0');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isoWeekNumber(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); // Thursday of this week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
}

/**
 * Fill in template variables (no scripting, by design):
 *   {{title}} {{folder}} {{date}} {{time}} {{yesterday}} {{tomorrow}} {{weekday}} {{week}} {{month}} {{year}}
 *   {{date:dddd, D MMMM YYYY}} {{date+7d}} {{date-1w:YYYY-MM-DD}} (offsets in d, w, m or y)
 * Format tokens: YYYY MMMM MMM MM M DD D dddd ddd HH mm ss
 */
export function applyTemplate(text: string, title: string, now = new Date(), folder = ''): string {
  const shift = (n: number, unit: string) => {
    const d = new Date(now);
    if (unit === 'd') d.setDate(d.getDate() + n);
    else if (unit === 'w') d.setDate(d.getDate() + 7 * n);
    else if (unit === 'm') d.setMonth(d.getMonth() + n);
    else if (unit === 'y') d.setFullYear(d.getFullYear() + n);
    return d;
  };
  const fmt = (f: string, d = now) =>
    f.replace(/YYYY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|mm|ss/g, (tok) => {
      switch (tok) {
        case 'YYYY': return String(d.getFullYear());
        case 'MMMM': return MONTH_NAMES[d.getMonth()];
        case 'MMM': return MONTH_NAMES[d.getMonth()].slice(0, 3);
        case 'MM': return pad2(d.getMonth() + 1);
        case 'M': return String(d.getMonth() + 1);
        case 'dddd': return DAY_NAMES[d.getDay()];
        case 'ddd': return DAY_NAMES[d.getDay()].slice(0, 3);
        case 'DD': return pad2(d.getDate());
        case 'D': return String(d.getDate());
        case 'HH': return pad2(d.getHours());
        case 'mm': return pad2(d.getMinutes());
        default: return pad2(d.getSeconds());
      }
    });
  return text
    .replace(/\{\{\s*title\s*\}\}/gi, title)
    .replace(/\{\{\s*folder\s*\}\}/gi, folder)
    .replace(/\{\{\s*(date|time)\s*(?:([+-]\d+)\s*([dwmy]))?\s*(?::\s*([^}]+))?\}\}/gi, (_m, kind: string, n?: string, unit?: string, f?: string) => {
      const d = n ? shift(Number(n), unit!.toLowerCase()) : now;
      return fmt(f?.trim() || (kind.toLowerCase() === 'time' ? 'HH:mm' : 'YYYY-MM-DD'), d);
    })
    .replace(/\{\{\s*yesterday\s*\}\}/gi, () => fmt('YYYY-MM-DD', shift(-1, 'd')))
    .replace(/\{\{\s*tomorrow\s*\}\}/gi, () => fmt('YYYY-MM-DD', shift(1, 'd')))
    .replace(/\{\{\s*weekday\s*\}\}/gi, () => DAY_NAMES[now.getDay()])
    .replace(/\{\{\s*week\s*\}\}/gi, () => String(isoWeekNumber(now)))
    .replace(/\{\{\s*month\s*\}\}/gi, () => MONTH_NAMES[now.getMonth()])
    .replace(/\{\{\s*year\s*\}\}/gi, () => String(now.getFullYear()));
}
