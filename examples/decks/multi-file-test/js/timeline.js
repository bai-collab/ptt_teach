// 純函式模組：由 js/main.js 以 ES module import（測試 module 圖載入）
export const SEGMENTS = [
  { title: "Segment A", duration: 6 },
  { title: "Segment B", duration: 8 },
  { title: "Segment C", duration: 6 },
];
export const DURATION = SEGMENTS.reduce((s, x) => s + x.duration, 0);

export function clamp(t) {
  return Math.min(Math.max(t, 0), DURATION);
}

// 回傳 { index, local }：t 落在哪一段與段內時間
export function segmentAt(t) {
  let acc = 0;
  for (let i = 0; i < SEGMENTS.length; i++) {
    const end = acc + SEGMENTS[i].duration;
    if (t < end || i === SEGMENTS.length - 1) return { index: i, local: t - acc };
    acc = end;
  }
}
