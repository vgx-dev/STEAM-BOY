# 要件定義：アニメ層（フローダッシュ）の Canvas 化

- 文書バージョン: 1.0
- 作成日: 2026-06-24
- 対象ファイル: リポジトリ直下の単一ファイル `STEAM-BOY.html`（HTML/CSS/JSすべて内包・ビルド工程なし・PWA）
- 区分: 問題A（連続アニメ再生中のFPS低下）の本命改善
- 想定実装者: **別ブランチで作業するAIエージェント（コールドスタート前提）**
- 本書の位置づけ: `docs/perf-refactoring-requirements.md`（親要件・§11にベースライン実測）の **問題A** に対する個別実装仕様。本書だけで作業を完結できるよう自己完結的に記述する。

> ⚠️ 重要原則（最優先・絶対厳守）
> 1. **機能を一切変えない**（作図・シミュレーション結果・操作系・保存/復元・印刷など全て不変）。
> 2. **見た目を完全維持する**（流れる白破線の太さ・色・速度・向き・配置・重なり順が現状と区別不能であること）。
> 3. 上記2点を満たした上で、**連続FPSを改善する**。トレードオフが生じる場合は機能・見た目維持を優先し、判断に迷う点は実装を止めて確認する。

---

## 1. 背景と目的

### 1.1 計測で確定した事実（親要件 §11 より）
実運用に近い図面（**ノード331 / エッジ372 / アクティブエッジ345**＝ほぼ全エッジに流体）で計測した結果：

- 通常操作中の **平均FPSは23〜25**、ロングフレーム多数。
- 一方、JSのホット関数（`renderAll` 等）は**操作時に数回しか呼ばれていない**。
- → **連続FPSを消費しているのはJSではなく、345本のアクティブエッジに付く `.flow-dash`（CSSの `stroke-dashoffset` アニメ）の毎フレーム再描画（ブラウザのPaint）**。
- `perf-lite`（500要素超で自動作動）は既にノード呼吸・ドレン波紋・蒸気グラデを停止済みだが、`.flow-dash` はコア表現のため止められず、これが連続FPSの「床」になっている。

### 1.2 目的
**多数の `.flow-dash`（SVG要素ごとのCSSアニメ）を、1枚のCanvasに毎フレーム描画する方式へ置き換える**ことで、SVGのPaintコストを排除し連続FPSを引き上げる。見た目・機能は完全維持する。

### 1.3 改善目標（親要件 §11.3 起点）
- 上記703要素・アクティブ345本の図面で、**連続FPSを平均 ≥48fps（現状比2倍以上）**、ロングフレームを1桁台へ。
- 見た目：SVG版とCanvas版を切り替えても**区別不能**（§7 受け入れ基準）。
- 機能回帰：ゼロ。

---

## 2. 現行アーキテクチャ（実装前に必ず理解すること）

行番号は本書作成時点の目安。実装時は識別子で再検索すること。

### 2.1 DOM階層と座標系
```
#workspace (スクロールビューポート, overflow:auto)            … CSS 111
  #canvas-wrapper (幅高 = baseWidth*zoom × baseHeight*zoom)   … CSS 112
    #canvas-container (幅高 = baseWidth × baseHeight,          … CSS 113
                       transform-origin:top left,
                       transform: scale(currentZoom))
      <canvas id="pdf-canvas">      … PDF背景
      <svg id="svg-layer">          … 配管・ノード（下記）
        <defs id="svg-defs">
        <g id="edges-group">        … エッジ群（各 edge-grp）
        <g id="nodes-group">        … ノード群（各 node-grp）
      <svg id="overlay-layer">      … スナップガイド/選択矩形/ゴースト等（最前面, pointer-events:none）
```
- **座標系**: すべて **base座標**（`Store.config.baseWidth × baseHeight`、既定2000×2000、PDF読込時はそのページのpx寸法）。SVGはbase座標を直接使用。
- **ズーム**: `Renderer.updateZoom()`（〜2979行）が `#canvas-container` に `transform: scale(currentZoom)` を適用。**個々の要素は座標もstroke幅もbase単位のまま**で、コンテナのCSS変換が一括拡大する。
- **スクロール**: `#workspace` の `scrollLeft/scrollTop`。
- マウス座標変換: `Renderer.getMouseSvgCoords(ev)`（2940行）= `(clientX - svgLayer.rect.left)/currentZoom`。

### 2.2 1本のアクティブエッジを構成する視覚要素（`renderAll` 内, 3043〜3220行付近）
各 `edge-grp`（`<g>`）の子要素：
| 要素 | クラス | 役割 | 連続アニメ |
|---|---|---|---|
| 当たり判定 | `.edge-hitbox` | 透明・太線・操作用 | なし |
| ベース下地 | `.flow-base` | 太い半透明の下地。stroke-width=`esw*2.6`、opacity=`0.12+0.2*max(.1,dRate)`、色=`data-fluid` | なし（※逆流時 `.backward` で `stroke-dasharray:1,14`） |
| 配管本線 | `.edge-path` | 配管の線。stroke-width=`var(--esw)`、opacity=0.6、色=`data-fluid` | なし |
| **流れ表現** | **`.flow-dash`** | **白破線が流れる。stroke=`rgba(255,255,255,0.8)`、stroke-width=`max(1.5,esw*0.8)`、`stroke-dasharray:6,6`、`animation:flowDash linear infinite`** | **あり（本件の対象）** |
| 中継点 | `.waypoint-handle` | ウェイポイントの白丸 | なし |

- `esw = Math.max(2, Store.config.nodeRadius*0.3)`。CSS変数 `--esw` にも反映（3042行）。
- **z-order（重要）**: `edges-group` 内の `flow-dash` は **`edge-path` の上**に重なる（同 `edge-grp` 内で後から append）。一方 **`nodes-group` は `edges-group` より後**にあるため、**全ノードは全エッジ（flow-dash含む）より前面**に描画される。
  → ∴ **`.flow-dash` の正しい重なりは「配管本線より上・ノードより下」**。Canvas化でもこの重なりを必ず維持する。

### 2.3 `.flow-dash` の厳密仕様（見た目再現の基準）
- パス形状: `Renderer.buildTrimmedPath(nFrom, edge, nTo)`（2943行）が返す **SVGパス文字列**（両端をノード半径で短縮＋ウェイポイントを角丸エルボーで接続、`M/L/Q`）。**Canvasでは `new Path2D(その文字列)` で完全に同一形状を再利用できる。**
- 色: `rgba(255,255,255,0.8)`（固定）。
- 線幅: `Math.max(1.5, esw*0.8)`（base単位）。線端: 丸（`stroke-linecap:round`）。
- 破線: `stroke-dasharray: 6,6`（base単位）。
- アニメ: `@keyframes flowDash { to { stroke-dashoffset: -24; } }`（449行）を `linear infinite`。
  - 周期（duration）: `0.6 / Math.max(.18, dRate)` 秒（3207行）。`dRate` は流速（`isBk?brate:rate`）。
  - 向き: 逆流（`isBk`）のとき `animation-direction: reverse`（3210行）。
- 状態派生値（既存の `renderAll` から取得可能, 3048〜3055行）:
  - `isBk`（逆流判定）, `ds`（表示流体 0〜3）, `dRate`（流速）。
  - `.flow-dash` は **`ds > FLUID.EMPTY(0)` のときのみ存在**（3196行）。

### 2.4 関連モード（Canvas化で必ず追従すること）
- **Culling**（`Culling`, 2794行〜）: 画面外エッジは `edge-grp[data-culled="1"]` となり `flow-dash` のアニメを `paused`（440行）。
- **perf-lite**（`Renderer.PERF_LITE_THRESHOLD=500`, 3017行）: 規模超過で重いアニメ停止。**`.flow-dash` 自体はperf-liteでも動作継続**（停止しない）。
- **残留 `data-residual="1"`**（460〜465行）: `flow-dash` を `paused`＋`stroke-opacity:0.8`、`flow-base` を `stroke-opacity:0.35`。＝流れない静的破線。
- **密閉 `edge-sealed` / 不確定 `data-uncertain`**: `flow-dash` ではなく別要素（`edge-sealed`/`edge-sealed-bg`）の脈動。**本件の対象外（SVGのまま）**。
- **エナジャイズ/デエナジャイズ**（`Animator`, 2188行〜）: 弁操作時の充填/排出は Web Animations API と `overlay-layer` のゴーストパスで表現する**一過性**アニメ。**本件の対象外（SVGのまま）**。ただしCanvas版の `flow-dash` と二重表示・チラつきが起きないこと（§5.6）。
- **逆流 `flow-base.backward`**（286行, `stroke-dasharray:1,14`）: これは `flow-base` の装飾で `flow-dash` とは別。**対象外（SVGのまま）**。

---

## 3. スコープ

### 3.1 やること（In Scope）
- **`.flow-dash`（流れる白破線）だけ**を、エッジごとのSVG要素から **単一Canvasの毎フレーム描画**へ置き換える。
- z-order維持のためのレイヤ構成変更（§5.1）。
- ズーム/スクロール/リサイズ/DPR への追従。
- Culling・perf-lite・残留・逆流・流速 の挙動を `.flow-dash` 相当で完全再現。
- SVG版↔Canvas版を切替できる**フィーチャーフラグ**（A/B比較・安全なフォールバック用）。
- Perfプローブ（既存 `?perf=1`）での前後計測。

### 3.2 やらないこと（Out of Scope）
- `flow-base` / `edge-path` / `edge-hitbox` / `waypoint-handle` / ノード描画（SVGのまま）。
- 密閉(`edge-sealed`)・不確定(`uncertain`)・ドレン波紋・ノード呼吸（SVGのまま）。
- `Animator` のエナジャイズ/デエナジャイズ（SVGのまま）。
- シミュレーション計算・データモデル・保存形式の変更。
- 配布形態（単一HTML/PWA）の変更。

---

## 4. 機能・見た目 維持要件（受け入れの前提）

- FR-A1: 全ての作図・選択・ドラッグ・ウェイポイント操作・弁操作・マスタ管理・手順書・印刷・シーケンス再生・保存/復元 が改修前と同一に動作する。
- FR-A2: `.flow-dash` の **太さ・色（rgba(255,255,255,0.8)）・破線(6,6)・流れる速度（duration式）・向き（逆流reverse）・形状（buildTrimmedPath）・重なり順（配管上・ノード下）** が現状と区別不能。
- FR-A3: Culling（画面外停止）・perf-lite（継続）・残留（静止＋opacity0.8）の見た目が現状と一致。
- FR-A4: ズーム0.2〜3.0、スクロール、ウィンドウ/パネルリサイズ、マルチDPR（Retina等）で破綻しない（位置ずれ・ぼやけ過多・ちらつきがない）。
- FR-A5: エッジの追加/削除/移動/ウェイポイント編集/弁操作 後に、Canvasの流れ表現が即時かつ正しく更新される。

---

## 5. 詳細設計

### 5.1 レイヤ構成（z-order維持・最重要）
`.flow-dash` を「配管本線の上・ノードの下」に描くため、**Canvasを `edges-group` と `nodes-group` の間**に挟む必要がある。Canvasは `<svg>` の内側に置けないため、**ノード描画を別SVGに分離**する。

実装手順（`Renderer.init`, 2881行付近を変更）:
1. `#canvas-container` の子の並びを次にする（前から背→前）:
   `#pdf-canvas` → `#svg-layer`（defs + edges-group のみ）→ **`#flow-canvas`（新規canvas）** → **`#node-layer`（新規svg, nodes-group を内包）** → `#overlay-layer`
2. `nodes-group` を新SVG `#node-layer` に移す。`#node-layer` は `#svg-layer` と同じ位置・サイズ（`position:absolute;inset:0;width:100%;height:100%`）。
3. `#flow-canvas` も同様に `position:absolute;inset:0;` で `#canvas-container` を覆う（base座標系に一致）。`pointer-events:none`。
4. **影響する既存箇所を必ず追従**（grepで洗い出すこと）:
   - `Renderer.getMouseSvgCoords`（2940行）: 基準 rect は `#svg-layer` のままで可（同一ボックス）。要確認。
   - 背景クリック判定（`isSvgBg`, 4291行付近の `ev.target.tagName==='svg' || id==='svg-layer'`）: **`#node-layer` の空白部クリックも背景として扱えるよう条件を拡張**。
   - `Renderer.svgLayer.style.pointerEvents` の切替（3992/4004行）: ノード操作が `#node-layer` 側になるため、必要なら同様に切替対象へ追加。
   - ノード関連の `document.getElementById('node-grp-...')` / `Renderer.nodesGroup` への参照はそのまま（`nodesGroup` の親が変わるだけ）。
   - `overlay-layer` は最前面のまま（変更不要）。

> ⚠️ このレイヤ分離が本作業で最も回帰リスクが高い。**分離直後に「機能だけ先に回帰確認」**（選択・ドラッグ・右クリック・背景クリック・ウェイポイント）してから、Canvas描画に進むこと。

### 5.2 Canvasのサイズ・解像度・座標
- `#flow-canvas` は `#canvas-container` 内に置き、**base座標で描画**する（SVGと同じ）。コンテナの `transform: scale(zoom)` がCanvas要素ごと拡大するため、**描画コードはズームを意識しなくてよい**（座標一致が保証され実装が単純）。
- 解像度（ビットマップ）:
  - `canvas.style.width = baseWidth + 'px'; canvas.style.height = baseHeight + 'px';`
  - `const SS = Math.min(window.devicePixelRatio||1, 2);`（メモリ上限のため2でクランプ）
  - `canvas.width = Math.round(baseWidth*SS); canvas.height = Math.round(baseHeight*SS);`
  - 描画前に `ctx.setTransform(SS,0,0,SS,0,0)` で base座標→ビットマップを合わせる。
- リサイズ契機: `baseWidth/baseHeight` 変更時（PDF読込 `handlePdfUpload` 4493行, 復元時）と DPR変化時に canvas を再構成する。`updateZoom` ではビットマップ再構成は不要（CSS scaleが拡大するため）。
- 既知の許容事項: zoom>1 ではCSS拡大により白破線がわずかに柔らかくなり得る。流れる細線のため許容。問題が出る場合の対策は §8 を参照。

### 5.3 描画データモデル（毎フレームの計算を避ける）
毎フレーム `buildTrimmedPath`（文字列生成）を呼ぶのは重い。**ジオメトリ/状態が変わった時だけ**更新する per-edge キャッシュを持つ。

`FlowCanvas._records: Map<edgeId, rec>` を用意。`rec` の例:
```
{
  path2d,        // new Path2D(pathStr)  … 形状（base座標）
  lineWidth,     // max(1.5, esw*0.8)
  durationSec,   // 0.6 / max(.18, dRate)
  reverse,       // !!isBk
  paused,        // 残留 or culled
  staticOpacity, // 残留時 0.8、通常 null（=0.8固定の白だが「流れない」表現用）
  active         // ds>0 か
}
```
- 更新タイミング: `renderAll` のエッジループ内で、その時点の `pathStr / esw / isBk / dRate / ds / data-residual / data-culled` から `rec` を作って `set`。エッジ削除時は `delete`。`ds===0` のエッジは `delete`（または `active:false`）。
- これにより **rAFループは文字列生成も流体判定もせず、`rec` を走査して `stroke` するだけ**になる。

### 5.4 描画ループ（rAF）
```
FlowCanvas._tick(now):
  ctx = canvas.2d
  ctx.setTransform(SS,0,0,SS,0,0)
  ctx.clearRect(0,0,baseWidth,baseHeight)      // base座標で全消去
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(255,255,255,0.8)'
  ctx.setLineDash([6,6])
  for (rec of records.values()):
    if (!rec.active) continue
    ctx.lineWidth = rec.lineWidth
    if (rec.paused):
      ctx.lineDashOffset = 0          // 流れない（残留/culled）
    else:
      // SVGの -24/duration（linear infinite）を時間で再現
      const t = now/1000
      const cycles = t / rec.durationSec          // 1周期で 24 進む
      let off = (cycles * 24) % 24
      ctx.lineDashOffset = rec.reverse ? off : -off   // SVGの符号(-24)と向きに一致させる
    ctx.stroke(rec.path2d)
  requestAnimationFrame(FlowCanvas._tick)
```
- **culled（画面外）の最適化**: `paused` でも `stroke` は呼ばれる。`#flow-canvas` をコンテナ内base全面にしているため画面外も描画され得る。**culledなエッジは `active:false` 同等にスキップ**してよい（描画コスト削減。見た目はSVG版がpaused=静止なのと差が出ないよう、culled中は描かない＝画面外なので不可視で一致）。要検証。
- **逆流の符号合わせ**: SVGの `stroke-dashoffset:-24` ＋ `direction:reverse` の見た目（流れる向き）と一致するよう、実機で正方向/逆方向を必ず目視確認し、必要なら符号を反転する。
- ループは Canvasモード有効時のみ起動。アクティブエッジが0本のフレームでも回り続けてよいが、**0本の状態が続く間はrAFを止め、`renderAll`/エッジ変化で再開**する省電力化を推奨（任意）。

### 5.5 `renderAll` との統合
- Canvasモード有効時、`renderAll` のエッジループでは **`.flow-dash` のSVG要素を生成しない**（3195〜3214行の生成分岐をフラグでスキップ）。既存の `.flow-dash` が残っていれば除去する。代わりに §5.3 の `rec` を更新する。
- `flow-base` / `edge-path` / hitbox / waypoint は従来どおりSVGで描く（変更しない）。
- SVGモード（フラグOFF）時は完全に従来動作（`.flow-dash` をSVGで生成、Canvasは非表示・ループ停止）。

### 5.6 他アニメとの整合
- **エナジャイズ/デエナジャイズ**（`Animator`）: 弁ON/OFF時、SVGの `flow-base/edge-path` に対するWeb Animations と overlayのゴーストはそのまま動く。Canvasの `flow-dash` は `renderAll` 後の最新状態で描かれるため、**充填演出中に流れ破線が先行表示されない**よう、`rec` の `active` 化タイミングが従来（SVG `.flow-dash` 生成タイミング）と一致していることを確認する（＝従来 `ds>0` で生成 → Canvasも `ds>0` で active。挙動同一）。
- **残留・密閉・不確定**: 残留は §5.4 の `paused`。密閉/不確定はSVGのまま（対象外）。Canvasの流れ破線がこれらに重複しないこと（残留時は流れない、密閉時はそもそも `ds` 状態が該当しない）を確認。

### 5.7 フィーチャーフラグ（必須）
- 既定: **Canvasモード ON**。
- 切替手段（いずれか・実装簡単なもの）:
  - URL: `?canvasflow=0` でSVGモード、`?canvasflow=1`/未指定でCanvasモード。
  - もしくは `Store.config.flowMode`（'canvas'|'svg'）＋設定UIトグル（任意）。
- 目的: 不具合時の**即時フォールバック**と、§7の**見た目A/B比較**。SVG↔Canvasを切り替えても破綻なく行き来できること。

---

## 6. 既存資産への参照（実装の足場）

| 用途 | 参照 |
|---|---|
| パス形状（base座標, SVG文字列）| `Renderer.buildTrimmedPath(nFrom,edge,nTo)` 2943 |
| パス長（速度/距離計算）| `Renderer.computePathLength` 2963 |
| 色マップ | `COLOR_MAP` 1799（※flow-dashは白固定なので色は不要だが他で使用） |
| 流体enum | `FLUID` 1796 / `data-fluid` CSS 413〜420 |
| esw 算出 | `Math.max(2, Store.config.nodeRadius*0.3)`（3029 等） |
| ズーム/コンテナ | `Renderer.updateZoom` 2979 / `Renderer.container`(=#canvas-container) |
| レイヤ初期化 | `Renderer.init` 2881〜（edges-group/nodes-group 生成） |
| エッジ描画ループ | `renderAll` 3043〜3220 |
| flow-dash 既存生成 | 3192〜3214 |
| flow-dash CSS | 448〜465 / keyframes 449 |
| Culling | `Culling` 2794〜 / `data-culled` 440 |
| perf-lite | `Renderer.PERF_LITE_THRESHOLD` 3017 / クラス切替 3035 |
| 計測 | Perfプローブ `?perf=1`（`window.__perf.snapshot()` 等。HUDの「テスト図面 大」で大規模図面生成可） |

---

## 7. 受け入れ基準

- **AC-A1 連続FPS（最重要）**: 703要素・アクティブ約345本（Perf HUDの「テスト図面 大」で生成可、または実図面）でアニメ放置中、`?perf=1` の `window.__perf.snapshot()` の `fps.avg` が **ベースライン約24fpsから ≥48fps へ改善**、`fps.longFrames` が大幅減。Canvas版とSVG版を同条件で計測し差分を本書に追記。
- **AC-A2 見た目パリティ**: フラグでSVG↔Canvasを切替え、同一図面・同一ズーム/スクロールで**流れ破線が区別不能**（太さ/色/速度/向き/破線間隔/形状/重なり順）。逆流・残留・culled・perf-lite の各状態でも一致。可能なら同一フレームのスクショ目視比較。
- **AC-A3 機能回帰ゼロ**: §4 の全項目を手動チェックリスト（§9）で確認し改修前と同一。
- **AC-A4 堅牢性**: ズーム0.2〜3.0、スクロール、リサイズ、Retina(DPR2)、PDF読込/差し替え、保存→復元、大量エッジ追加/削除で破綻・リーク・ちらつきなし。
- **AC-A5 フォールバック**: `?canvasflow=0` で完全に従来SVG動作へ戻れる。
- **AC-A6 コンソール健全**: 新規エラー・未破棄rAF・未破棄リスナーなし。

---

## 8. リスクと対策

| リスク | 対策 |
|---|---|
| レイヤ分離による操作系の回帰（クリック/選択/背景判定）| §5.1 の影響箇所を網羅追従。分離直後に機能だけ先行回帰確認。フラグで即フォールバック |
| z-order不一致（破線がノード上/配管下に出る）| Canvasを edges と nodes の間に厳密配置。密な図面で目視確認（他エッジ破線がノードに被らないか）|
| 逆流の流れる向きが反転 | 実機で正/逆方向を目視し符号確定（§5.4）|
| zoom>1 で破線がぼやける | 既定SS=2で緩和。不足なら zoom変更時に `canvas.width=baseW*min(zoom,上限)` へ再構成し `ctx.scale` する“ズーム適応解像度”を追加（任意拡張）|
| 巨大PDFでのcanvasメモリ | SSを2でクランプ。極端な `baseWidth*baseHeight` では上限面積でSSを1へ自動降格 |
| Animator演出との二重表示/ちらつき | §5.6。activeのタイミングを従来`.flow-dash`生成と一致させる |
| 期待した効果が出ない | Perf計測で判定（§7 AC-A1）。効果不足なら `flow-base` もCanvas化する拡張を別途検討（本書の範囲外）|

---

## 9. 段階的実装手順（小コミット推奨）

各ステップ後に構文確認（`node --check` 等）し、機能回帰を都度チェック。いつでもフラグで戻せる状態を保つ。

1. **フラグ土台**: `?canvasflow`／`Store.config.flowMode` を読み、既定値を決める。何も描画は変えない。
2. **レイヤ分離**: `nodes-group` を新SVG `#node-layer` へ、`#flow-canvas` を edges/nodes 間に追加（描画は空）。§5.1 の影響箇所を追従。**機能だけ回帰確認**（選択/ドラッグ/右クリック/背景クリック/ウェイポイント）。
3. **Canvas基盤**: サイズ/DPR/リサイズ/座標（§5.2）。空クリアのみ。
4. **rec構築**: `renderAll` で per-edge `rec` を更新（まだCanvasに描かない／SVG `.flow-dash` も残す）。
5. **Canvas描画**: rAFループで `rec` を描画（§5.4）。この時点でSVG `.flow-dash` と二重表示になるので、**並べて見た目一致を比較**（A/B検証に活用）。
6. **SVG flow-dash 停止**: Canvasモード時はSVG `.flow-dash` を生成しない（§5.5）。二重表示解消。
7. **モード追従**: culled/perf-lite/残留/逆流 を `rec`/ループに反映（§5.4・5.6）。
8. **省電力・後始末**: アクティブ0でrAF停止、エッジ削除でrec破棄、リーク確認。
9. **計測と記録**: `?perf=1` でSVG版/Canvas版を計測し §7 を判定、結果を本書（または親要件 §11）へ追記。

---

## 10. テスト観点チェックリスト

- [ ] 流れ破線の太さ/色/破線間隔/速度/向きがSVG版と区別不能（通常・逆流）
- [ ] 重なり順：破線は配管本線の上、ノードの下
- [ ] ウェイポイント追加/移動/削除で形状が即追従
- [ ] エッジ追加/削除/ノード移動で流れ表現が即更新
- [ ] 弁ON/OFFの充填/排出演出と二重表示・ちらつきがない
- [ ] 残留（黄/紫）エッジは流れず静止、opacity一致
- [ ] 画面外（culled）で描画コストが発生しない／戻すと再開
- [ ] perf-lite作動下でも流れ破線は継続表示
- [ ] ズーム0.2/1.0/3.0・スクロール・リサイズ・DPR2で位置とぼやけが許容内
- [ ] PDF読込/差し替え・保存→復元 後も正常
- [ ] `?canvasflow=0` で従来SVG動作に完全復帰
- [ ] コンソールエラー/リークなし
- [ ] `?perf=1` で連続FPSが目標（≥48fps）に改善

---

## 11. 完了の定義（Definition of Done）
- §7 の全AC（特に AC-A1 FPS、AC-A2 見た目パリティ、AC-A3 機能回帰ゼロ）を満たす。
- §10 チェックリストが全項目クリア。
- 計測結果（SVG版/Canvas版のFPS）が記録されている。
- フィーチャーフラグでSVG/Canvasを安全に切替できる。
- 単一HTML/PWAの配布形態を維持している。

---

## 12. 実装記録（2026-06-24）

### 12.1 実装サマリ
`.flow-dash`（流れる白破線）を **エッジごとのSVG要素＋CSSアニメ** から **1枚のCanvasへの毎フレーム描画** へ置き換えた。`FlowCanvas` モジュール（`STEAM-BOY.html` 内）を新設し、`renderAll` のエッジループでジオメトリ/状態が変わった時だけ per-edge レコードを更新、rAFループでレコードを `stroke` する。見た目（太さ/色/破線間隔/速度/向き/形状/重なり順）と機能はSVG版と一致するよう実装。

### 12.2 §5.1 からの設計変更（レイヤ分離方式）— 重要
本書 §5.1 は「**nodes-group** を新SVG `#node-layer` へ移す」方針だが、実装では **「edges-group を新SVG `#edge-layer` へ移し、nodes は `#svg-layer` に残す」** 方式を採用した。

- **理由**: ノードを対象とする `#svg-layer` スコープのCSS（`always-show-labels` / `perf-lite` / `isolation-mode` / `manual-picking` / `manual-link-hl`）や `querySelector('#svg-layer ...')`、ImageViewer / MasterTable のホバー系リスナーが10箇所以上あり、**ノード移動は回帰リスクが極めて高い**。一方エッジ系の見た目CSSは大半が `g.edge-grp ...` の**層に依存しないグローバルセレクタ**のため、エッジ移動の影響は最小（実質3点のみ）。
- **z-order・機能・見た目は §5.1 と同一結果**（背→前: `#pdf-canvas → #edge-layer → #flow-canvas → #svg-layer(ノード) → #overlay-layer`）。最優先原則（機能・見た目の完全維持）に最も適う選択として採用。

### 12.3 主な変更点
- **レイヤ**: `#edge-layer`(SVG, エッジ+defs) と `#flow-canvas`(Canvas) を追加。`#svg-layer` はノード専用化。`#svg-layer` root を `pointer-events:none`、`#nodes-group` を `auto` にして、空白部クリックを最下層 `#edge-layer` へ通す（背景判定の受け皿が `#edge-layer` に移行）。
- **イベント**: メインの `pointerdown` を `#svg-layer` から共通祖先 `#canvas-container` へ委譲（エッジ=edge-layer/ノード=svg-layer の両方を受ける）。`isSvgBg` に `edge-layer` を追加。スクロール時のヒットテスト無効化は `edge-layer`+`nodes-group` を対象に変更。`isolation-mode`/`manual-picking` のクラス付与先を `#canvas-container` へ。
- **描画**: `FlowCanvas._records`(Map) と rAF ループ。SS=min(DPR,2)、ビットマップ面積 16M px 上限。`durationSec=0.6/max(.18,dRate)`、`lineDashOffset` を時間ベースで算出（正方向 `-off` / 逆流 `+off`、破線周期12と合同で SVG と一致）。残留は `offset=0`＋α0.64（=0.8×0.8）で凍結再現。
- **カリング同期**: `Culling.apply` が `rec.hidden`(display-cull) を更新し、Canvasも同期して非描画（流れ破線が配管より先に出るチラつきを防止）。加えてrAF内で**ライブのビューポートカリング**を行い画面外は毎フレームスキップ。
- **追従**: PDF読込・復元・ウィンドウリサイズ/ズーム(DPR変化)で `FlowCanvas.resize()`。アクティブな流れが0になればrAF自動停止。

### 12.4 フィーチャーフラグ / フォールバック
- 既定 **Canvasモード ON**。`?canvasflow=0` で従来の **SVG `.flow-dash` 方式**へ完全フォールバック（AC-A5）。
- Canvas の2Dコンテキスト取得に失敗した場合は自動的にSVGモードへ降格。
- `window.__flowCanvas` でデバッグ/AB比較可能。

### 12.5 検証状況
- **構文**: `node --check`（スクリプト抽出）パス。
- **コアロジック単体テスト**（ブラウザ非依存）: `lineDashOffset` 数式が SVG と破線周期12で合同・正/逆方向が逆・ビューポートカリング判定・残留α=0.64 をテストし全パス。
- **FlowCanvasオブジェクト統合テスト**（モックCanvas）: フラグ既定ON/`?canvasflow=0`でOFF、resizeのSSクランプ、画面外/hidden/非アクティブのスキップ、残留の凍結とα、アクティブ0でのループ停止を確認し全パス。
- **未実施（要実機）**: AC-A1 の実FPS計測（`?perf=1`）と AC-A2 のスクショ目視パリティ比較は、ブラウザ実機での確認が必要。下表は実測後に追記すること。

| シナリオ | SVG版 fps.avg/long | Canvas版 fps.avg/long | 判定 |
|---|---|---|---|
| 703要素・アクティブ約345本 放置 | （要実機: ?canvasflow=0） | （要実機: 既定） | ≥48fps? |
