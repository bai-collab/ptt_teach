# 教學網頁動畫公版（repo-to-teaching-animation v0.4.0）

之後的教學網頁動畫都用這份公版製作。可以單獨開成網頁，也能放進 ptt_teach 當內建簡報（`?embed=1`）。

## 公版版面

1. **整份進度條**：涵蓋整部動畫，有分段刻度，右側顯示「秒數 / 總長」；這一列可收合，預設收起並記住狀態。
2. **標註工具**：畫筆、文字、5 種顏色、收回上一筆、清除本段標註；這一列可收合，預設收起。標註每段各自分開，只存在瀏覽器記憶體，重新整理就消失，不會送出網路。
3. **舞台依視窗縮放**：標題、舞台、字幕與控制列佔滿一個視窗高；舞台在剩下的空間裡維持 16:9，用容器查詢單位計算，不扣固定像素。
4. **嵌入模式**：`?embed=1` 只留舞台與字幕，播放由 ptt_teach 用 postMessage 控制；嵌入時不出現標註工具，也不讀寫 localStorage。

## 檔案

| 檔案 | 用途 |
|---|---|
| `SKILL.md` | 製作流程與契約（Claude Code／Codex Skill 格式） |
| `assets/template.html` | 播放器外殼（公版） |
| `assets/common-scenes.js` | 共用圖形 |
| `scripts/assemble.mjs` | 把範本、共用圖形和場景檔組成 `index.html` |
| `scripts/check-anim.mjs`、`scripts/fs-check.mjs` | 契約、冪等、溢出、embed 與全螢幕字幕檢查（需要本機 Chrome） |
| `scripts/screen-text.mjs` | 擷取各段畫面文字 |

`SKILL.md` 裡提到的 `projects/…`、`brain/…` 是原作者本機工作區的相對路徑，只供參考，這個 repo 裡沒有這些路徑。
