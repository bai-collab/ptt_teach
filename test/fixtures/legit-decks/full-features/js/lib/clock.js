// 第 2 層：純函式（與 deck.json segments 一致）
export const SEGMENTS = [
  { title: "Media and data", duration: 5 },
  { title: "Modules", duration: 5 },
];
export const DURATION = SEGMENTS.reduce((s, x) => s + x.duration, 0);
export const clamp = (t) => Math.min(Math.max(t, 0), DURATION);
export function segmentAt(t) {
  let acc = 0;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const end = acc + SEGMENTS[i].duration;
    if (t < end || i === SEGMENTS.length - 1) return { index: i, local: t - acc };
    acc = end;
  }
}
