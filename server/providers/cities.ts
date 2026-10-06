// Loose Hebrew city-name matching ("תל אביב-יפו" == "תל אביב", "קרית" == "קריית").
const clean = (s: string) =>
  s.replace(/[֑-ׇ"'׳״\-–]/g, ' ').replace(/קריית/g, 'קרית').replace(/\s+/g, ' ').trim();

export function sameCity(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = clean(a), y = clean(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ') || x.includes(y) || y.includes(x);
}
