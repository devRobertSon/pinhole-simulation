"use strict";

/* =====================================================================
 * 바늘구멍(핀홀) 상 시뮬레이터
 *
 * 물리 모델
 *   배율          m = d_i / d_o
 *   번짐 배율     s = 1 + d_i / d_o
 *   스크린 상 = (m배·상하좌우 반전한 광원 모양) ⊛ (s배 확대한 구멍 모양)
 *
 * 구현: 합성곱을 "스프라이트 가산 합성"으로 계산한다.
 *   - 광원 상 footprint와 구멍 번짐 kernel 중 큰 쪽을 연속(채워진) 스프라이트로,
 *     작은 쪽을 격자 샘플(점들)로 만들어, 각 샘플 위치에 스프라이트를 가산한다.
 *   - 둘 중 큰 쪽을 스프라이트로 쓰므로 점 사이 틈 없이 매끈하게 합성된다.
 *   - 마지막에 밝기를 자동 정규화한다.
 * ===================================================================== */

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  do: $("do"), di: $("di"), hole: $("hole"), srcSize: $("srcSize"),
  srcShape: $("srcShape"), holeShape: $("holeShape"),
  farSource: $("farSource"), showGrid: $("showGrid"),
  doVal: $("doVal"), diVal: $("diVal"), holeVal: $("holeVal"), srcSizeVal: $("srcSizeVal"),
  diagram: $("diagram"), screen: $("screen"), readout: $("readout"),
  drawWrap: $("drawWrap"), drawPad: $("drawPad"), clearDraw: $("clearDraw"),
};

const dgCtx = els.diagram.getContext("2d");
const scCtx = els.screen.getContext("2d");

// 내부 계산 해상도 (저해상도로 합성, 화면에는 확대해 표시)
const N = 220;
const acc = document.createElement("canvas");
acc.width = acc.height = N;
const accCtx = acc.getContext("2d", { willReadFrequently: true });

// 광원 직접 그리기용 버퍼
const drawCtx = els.drawPad.getContext("2d");
drawCtx.fillStyle = "#000";
drawCtx.fillRect(0, 0, els.drawPad.width, els.drawPad.height);

/* =====================================================================
 * 모양 그리기 (정규화 좌표: 중심 0, 한 변 = size, y는 화면 기준 아래쪽)
 * ===================================================================== */
function drawShapePath(ctx, type, size) {
  const h = size / 2;
  ctx.beginPath();
  switch (type) {
    case "dot":
      ctx.arc(0, 0, size * 0.18, 0, Math.PI * 2);
      break;
    case "circle":
      ctx.arc(0, 0, h, 0, Math.PI * 2);
      break;
    case "square":
      ctx.rect(-h, -h, size, size);
      break;
    case "slit": // 가는 세로 틈
      ctx.rect(-size * 0.09, -h, size * 0.18, size);
      break;
    case "triangle":
      ctx.moveTo(0, -h);
      ctx.lineTo(h * 0.92, h * 0.85);
      ctx.lineTo(-h * 0.92, h * 0.85);
      ctx.closePath();
      break;
    case "cross": { // 십자 ✚
      const t = size * 0.16;
      ctx.rect(-h, -t, size, 2 * t);     // 가로 막대
      ctx.rect(-t, -h, 2 * t, size);     // 세로 막대
      break;
    }
    case "star":
      starPath(ctx, 0, 0, h, h * 0.42, 5);
      break;
    case "arrow": { // 위쪽 화살표 ↑
      ctx.moveTo(0, -h);                 // 머리 꼭짓점
      ctx.lineTo(h * 0.55, -h * 0.1);
      ctx.lineTo(h * 0.2, -h * 0.1);
      ctx.lineTo(h * 0.2, h);            // 몸통 오른쪽
      ctx.lineTo(-h * 0.2, h);
      ctx.lineTo(-h * 0.2, -h * 0.1);
      ctx.lineTo(-h * 0.55, -h * 0.1);
      ctx.closePath();
      break;
    }
    case "ga": { // ㄱ : 위 가로획 + 오른쪽 세로획
      ctx.rect(-h * 0.9, -h * 0.9, size * 0.9, size * 0.26);  // 가로획(위)
      ctx.rect(h * 0.4, -h * 0.9, size * 0.26, size * 0.9);    // 세로획(오른쪽, 아래로)
      break;
    }
    case "F": {
      const w = size * 0.26;
      ctx.rect(-h * 0.85, -h, w, size);                 // 세로 기둥(왼쪽)
      ctx.rect(-h * 0.85, -h, size * 0.85, h * 0.46);    // 위 가로획
      ctx.rect(-h * 0.85, -h * 0.1, size * 0.6, h * 0.4);// 가운데 가로획
      break;
    }
    default:
      ctx.arc(0, 0, h, 0, Math.PI * 2);
  }
}

function starPath(ctx, cx, cy, rOut, rIn, points) {
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOut : rIn;
    const a = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// 채워진 스프라이트 캔버스 생성 (흰색). flip=true면 180° 회전(상하좌우 반전).
function makeSprite(type, extentPx, flip) {
  const pad = 2;
  const sz = Math.max(2, Math.ceil(extentPx));
  const c = document.createElement("canvas");
  c.width = c.height = sz + pad * 2;
  const cx = c.width / 2;
  const ctx = c.getContext("2d");
  ctx.save();
  ctx.translate(cx, cx);
  if (flip) ctx.scale(-1, -1);
  ctx.fillStyle = "#fff";
  if (type === "custom") {
    drawCustomSprite(ctx, sz);
  } else {
    drawShapePath(ctx, type, sz);
    ctx.fill();
  }
  ctx.restore();
  return c;
}

// 직접 그린 광원을 스프라이트에 그려넣기
function drawCustomSprite(ctx, sz) {
  // drawPad 내용을 흰색으로 sz 크기에 맞춰 배치
  ctx.drawImage(els.drawPad, -sz / 2, -sz / 2, sz, sz);
}

/* =====================================================================
 * 모양 샘플링: 작은 격자에서 ON 픽셀들의 (오프셋px, 가중치) 목록 반환
 *   extentPx : 실제 화면에서 이 모양이 차지할 픽셀 크기
 *   flip     : true면 좌표 반전(광원 상 반전용)
 * ===================================================================== */
function sampleShape(type, extentPx, flip) {
  const K = Math.min(48, Math.max(9, Math.round(extentPx)));
  const c = document.createElement("canvas");
  c.width = c.height = K;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  if (type === "custom") {
    ctx.drawImage(els.drawPad, 0, 0, K, K);
  } else {
    ctx.save();
    ctx.translate(K / 2, K / 2);
    drawShapePath(ctx, type, K);
    ctx.fill();
    ctx.restore();
  }
  const data = ctx.getImageData(0, 0, K, K).data;
  const pts = [];
  const f = flip ? -1 : 1;
  for (let j = 0; j < K; j++) {
    for (let i = 0; i < K; i++) {
      const a = data[(j * K + i) * 4]; // 흰색이므로 R 채널 = 밝기
      if (a > 24) {
        const fx = (i + 0.5) / K - 0.5; // [-0.5, 0.5]
        const fy = (j + 0.5) / K - 0.5;
        pts.push({
          ox: f * fx * extentPx,
          oy: f * fy * extentPx,
          w: a / 255,
        });
      }
    }
  }
  return pts;
}

/* =====================================================================
 * 메인 렌더링
 * ===================================================================== */
function getState() {
  const di = parseFloat(els.di.value);
  let dq = parseFloat(els.do.value);
  if (els.farSource.checked) dq = 100000; // 평행광 근사
  return {
    do: dq,
    di,
    hole: parseFloat(els.hole.value),
    srcSize: parseFloat(els.srcSize.value),
    srcShape: els.srcShape.value,
    holeShape: els.holeShape.value,
    showGrid: els.showGrid.checked,
  };
}

function render() {
  const st = getState();
  const m = st.di / st.do;          // 배율
  const s = 1 + st.di / st.do;      // 번짐 배율
  const sharpCm = m * st.srcSize;   // 또렷한 상 크기 (cm)
  const blurCm = s * st.hole;       // 번짐 폭 (cm)

  // 화면에 담을 물리 시야(cm): 상 전체가 들어오도록 자동 맞춤
  const extentCm = sharpCm + blurCm;
  const viewCm = Math.max(extentCm * 1.35, 0.4);
  const pxPerCm = N / viewCm;

  const sourceFootPx = sharpCm * pxPerCm;
  const holeKernPx = blurCm * pxPerCm;

  // 가산 합성 준비
  accCtx.globalCompositeOperation = "source-over";
  accCtx.fillStyle = "#000";
  accCtx.fillRect(0, 0, N, N);
  accCtx.globalCompositeOperation = "lighter";

  const cx = N / 2;
  let samples, sprite;
  if (sourceFootPx >= holeKernPx) {
    // 광원 상이 더 큼 → 광원을 연속 스프라이트, 구멍을 샘플
    sprite = makeSprite(st.srcShape, sourceFootPx, true);
    samples = sampleShape(st.holeShape, holeKernPx, false);
  } else {
    // 번짐이 더 큼 → 구멍을 연속 스프라이트, 광원을 샘플(반전)
    sprite = makeSprite(st.holeShape, holeKernPx, false);
    samples = sampleShape(st.srcShape, sourceFootPx, true);
  }

  const half = sprite.width / 2;
  // 너무 많은 샘플이면 가중치만 낮추고 그대로 (정규화가 처리)
  const alpha = Math.min(1, 8 / Math.sqrt(samples.length || 1));
  for (let k = 0; k < samples.length; k++) {
    const p = samples[k];
    accCtx.globalAlpha = alpha * p.w;
    accCtx.drawImage(sprite, cx + p.ox - half, cx + p.oy - half);
  }
  accCtx.globalAlpha = 1;
  accCtx.globalCompositeOperation = "source-over";

  // 밝기 자동 정규화 + 그레이스케일 채색
  const img = accCtx.getImageData(0, 0, N, N);
  const d = img.data;
  let max = 1;
  for (let i = 0; i < d.length; i += 4) if (d[i] > max) max = d[i];
  const scale = 255 / max;
  const gamma = 0.85;
  for (let i = 0; i < d.length; i += 4) {
    let v = (d[i] * scale) / 255;
    v = Math.pow(Math.min(1, v), gamma) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  accCtx.putImageData(img, 0, 0);

  // 화면 캔버스에 확대 표시
  scCtx.imageSmoothingEnabled = true;
  scCtx.fillStyle = "#05060c";
  scCtx.fillRect(0, 0, els.screen.width, els.screen.height);
  scCtx.drawImage(acc, 0, 0, N, N, 0, 0, els.screen.width, els.screen.height);

  if (st.showGrid) drawGrid(scCtx, els.screen.width, els.screen.height, viewCm);

  updateReadout(m, s, sharpCm, blurCm, viewCm);
  drawDiagram(st, m);
}

function drawGrid(ctx, W, H, viewCm) {
  // 1, 2, 5 ... 적당한 격자 간격(cm) 선택
  const target = viewCm / 8;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const cands = [1, 2, 5, 10].map((x) => x * pow);
  let step = cands[0];
  for (const c of cands) if (Math.abs(c - target) < Math.abs(step - target)) step = c;

  const pxPerCm = W / viewCm;
  ctx.save();
  ctx.strokeStyle = "rgba(110,168,255,0.18)";
  ctx.fillStyle = "rgba(170,190,240,0.55)";
  ctx.lineWidth = 1;
  ctx.font = "11px sans-serif";
  const cx = W / 2, cy = H / 2;
  for (let g = 0; g * pxPerCm * step <= W / 2 + 1; g++) {
    for (const dir of [1, -1]) {
      if (g === 0 && dir === -1) continue;
      const x = cx + dir * g * step * pxPerCm;
      const y = cy + dir * g * step * pxPerCm;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }
  // 중심 강조
  ctx.strokeStyle = "rgba(110,168,255,0.4)";
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
  ctx.fillText(`격자 1칸 = ${step >= 1 ? step : step.toFixed(1)} cm`, 8, H - 8);
  ctx.restore();
}

function updateReadout(m, s, sharpCm, blurCm, viewCm) {
  const rows = [
    ["배율 m = dᵢ/dₒ", m >= 100 ? "≈ 0 (아주 작음)" : m.toFixed(2) + " 배"],
    ["번짐 배율 s = 1 + dᵢ/dₒ", s.toFixed(2) + " 배"],
    ["또렷한 상 크기", sharpCm.toFixed(2) + " cm"],
    ["번짐 폭", blurCm.toFixed(2) + " cm"],
    ["상하·좌우", "180° 뒤집힘"],
    ["보는 범위(가로)", viewCm.toFixed(1) + " cm"],
  ];
  els.readout.innerHTML = rows
    .map((r) => `<span class="rk">${r[0]}</span><span class="rv">${r[1]}</span>`)
    .join("");
}

/* =====================================================================
 * 왼쪽 장치 모식도
 * ===================================================================== */
function drawDiagram(st, m) {
  const ctx = dgCtx;
  const W = els.diagram.width, H = els.diagram.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0b0e1a";
  ctx.fillRect(0, 0, W, H);

  const padL = 60, padR = 60;
  const span = W - padL - padR;
  const cy = H / 2;

  // 거리 비율로 구멍 위치 결정 (평행광이면 광원을 맨 왼쪽 가까이)
  const dispDo = st.farSource ? st.di * 2.2 : st.do;
  const total = dispDo + st.di;
  const holeX = padL + (dispDo / total) * span;
  const srcX = padL;
  const scrX = W - padR;

  // 크기 스케일 (도식용)
  const sScale = Math.min(120 / Math.max(st.srcSize, 1), 8);
  const srcH = Math.min(st.srcSize * sScale, H * 0.36);
  const imgH = Math.min(srcH * m, H * 0.42);

  // --- 스크린 ---
  ctx.strokeStyle = "#aab4e0";
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(scrX, cy - H * 0.42); ctx.lineTo(scrX, cy + H * 0.42); ctx.stroke();
  label(ctx, "스크린", scrX, cy + H * 0.42 + 16, "#aab4e0");

  // --- 구멍 판 (위/아래 벽 + 가운데 구멍) ---
  ctx.strokeStyle = "#7f8bbf";
  ctx.lineWidth = 4;
  const gap = 7;
  ctx.beginPath(); ctx.moveTo(holeX, cy - H * 0.42); ctx.lineTo(holeX, cy - gap); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(holeX, cy + gap); ctx.lineTo(holeX, cy + H * 0.42); ctx.stroke();
  label(ctx, "구멍", holeX, cy + H * 0.42 + 16, "#7f8bbf");

  // --- 광원(화살표/모양) ---
  ctx.save();
  ctx.translate(srcX, cy);
  ctx.fillStyle = "#ffd166";
  drawShapePath(ctx, st.srcShape === "custom" ? "arrow" : st.srcShape, srcH);
  if (st.srcShape === "custom") { ctx.fill(); }
  else ctx.fill();
  ctx.restore();
  label(ctx, st.farSource ? "광원(아주 멀리)" : "광원", srcX, cy + H * 0.42 + 16, "#ffd166");

  // --- 상 (반전, 스크린 위) ---
  ctx.save();
  ctx.translate(scrX, cy);
  ctx.scale(-1, -1); // 반전
  ctx.fillStyle = "rgba(110,168,255,0.85)";
  drawShapePath(ctx, st.srcShape === "custom" ? "arrow" : st.srcShape, imgH);
  ctx.fill();
  ctx.restore();
  label(ctx, "상(거꾸로)", scrX, cy - H * 0.42 - 8, "#6ea8ff");

  // --- 대표 광선: 광원 위/아래 끝 → 구멍 → 스크린 (교차) ---
  ctx.lineWidth = 1.4;
  const srcTop = cy - srcH / 2, srcBot = cy + srcH / 2;
  const imgTop = cy - imgH / 2, imgBot = cy + imgH / 2;
  drawRay(ctx, srcX, srcTop, holeX, cy, scrX, imgBot, "rgba(255,209,102,0.8)");
  drawRay(ctx, srcX, srcBot, holeX, cy, scrX, imgTop, "rgba(110,168,255,0.8)");

  // 거리 표시
  dimLine(ctx, srcX, holeX, cy + H * 0.42 + 36, "dₒ = " + (st.farSource ? "∞" : st.do + " cm"));
  dimLine(ctx, holeX, scrX, cy + H * 0.42 + 36, "dᵢ = " + st.di + " cm");
}

function drawRay(ctx, x0, y0, xh, yh, x1, y1, color) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(xh, yh);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  // 진행 방향 점
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(xh, yh, 2.5, 0, Math.PI * 2); ctx.fill();
}

function label(ctx, text, x, y, color) {
  ctx.fillStyle = color;
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
  ctx.textAlign = "start";
}

function dimLine(ctx, x0, x1, y, text) {
  ctx.strokeStyle = "rgba(170,180,220,0.5)";
  ctx.fillStyle = "rgba(200,210,240,0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, y); ctx.lineTo(x1, y);
  ctx.moveTo(x0, y - 4); ctx.lineTo(x0, y + 4);
  ctx.moveTo(x1, y - 4); ctx.lineTo(x1, y + 4);
  ctx.stroke();
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, (x0 + x1) / 2, y - 6);
  ctx.textAlign = "start";
}

/* =====================================================================
 * 입력 처리
 * ===================================================================== */
function syncLabels() {
  els.doVal.textContent = els.farSource.checked ? "∞ (매우 멀리)" : els.do.value + " cm";
  els.diVal.textContent = els.di.value + " cm";
  els.holeVal.textContent = parseFloat(els.hole.value).toFixed(1) + " cm";
  els.srcSizeVal.textContent = parseFloat(els.srcSize.value).toFixed(1) + " cm";
  els.do.disabled = els.farSource.checked;
}

let raf = null;
function schedule() {
  syncLabels();
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = null; render(); });
}

["do", "di", "hole", "srcSize", "srcShape", "holeShape", "farSource", "showGrid"].forEach((k) => {
  els[k].addEventListener("input", schedule);
  els[k].addEventListener("change", schedule);
});

// 광원 모양 = 직접 그리기일 때 그리기 패드 표시
els.srcShape.addEventListener("change", () => {
  els.drawWrap.hidden = els.srcShape.value !== "custom";
});

/* ---------- 직접 그리기 패드 ---------- */
let drawing = false;
function padPos(e) {
  const r = els.drawPad.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return {
    x: ((t.clientX - r.left) / r.width) * els.drawPad.width,
    y: ((t.clientY - r.top) / r.height) * els.drawPad.height,
  };
}
function padDraw(e) {
  if (!drawing) return;
  e.preventDefault();
  const p = padPos(e);
  drawCtx.fillStyle = "#fff";
  drawCtx.beginPath();
  drawCtx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  drawCtx.fill();
  schedule();
}
els.drawPad.addEventListener("pointerdown", (e) => { drawing = true; padDraw(e); });
els.drawPad.addEventListener("pointermove", padDraw);
window.addEventListener("pointerup", () => { drawing = false; });
els.clearDraw.addEventListener("click", () => {
  drawCtx.fillStyle = "#000";
  drawCtx.fillRect(0, 0, els.drawPad.width, els.drawPad.height);
  schedule();
});

/* ---------- 프리셋 ---------- */
const presets = {
  equal:  { do: 50, di: 50, hole: 0.5, srcSize: 12, srcShape: "ga",     holeShape: "circle", far: false },
  blur:   { do: 50, di: 50, hole: 6,   srcSize: 12, srcShape: "F",      holeShape: "circle", far: false },
  far:    { do: 500, di: 80, hole: 4,  srcSize: 12, srcShape: "arrow",  holeShape: "star",   far: true  },
  shape:  { do: 60, di: 120, hole: 7,  srcSize: 3,  srcShape: "dot",    holeShape: "star",   far: false },
};
document.querySelectorAll(".presets button").forEach((b) => {
  b.addEventListener("click", () => {
    const p = presets[b.dataset.preset];
    if (!p) return;
    els.do.value = p.do; els.di.value = p.di; els.hole.value = p.hole;
    els.srcSize.value = p.srcSize; els.srcShape.value = p.srcShape;
    els.holeShape.value = p.holeShape; els.farSource.checked = p.far;
    els.drawWrap.hidden = els.srcShape.value !== "custom";
    schedule();
  });
});

// 초기 렌더
schedule();
