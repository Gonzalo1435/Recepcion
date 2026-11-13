"use strict";
/* Recepción en terreno: registra equipos sin internet y sin cuenta.
   Todo queda en el teléfono (IndexedDB). Al terminar se arma un paquete .zip que el coordinador
   importa en la app principal «Recepción de Equipamiento». */
const VERSION = "1.0.0";
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const normSerie = s => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
const slug = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "x";
const hoy = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const hora = t => new Date(t).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
let toastT; function toast(m, ms = 2600) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), ms); }
const CHECKS = [["embalaje", "Embalaje íntegro"], ["dano", "Sin daño visible"], ["etiqueta", "Etiqueta legible"], ["docs", "Manual / documentación"]];
const ESTADOS = { conforme: "Conforme", observado: "Observado", rechazado: "Rechazado" };

/* ============ almacenamiento local ============ */
const DB = {
  p: null,
  open() {
    return this.p ||= new Promise((ok, ko) => {
      const r = indexedDB.open("terreno", 1);
      r.onupgradeneeded = () => { for (const s of ["recs", "units", "docs", "fotos", "kv"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
    });
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((ok, ko) => {
      const t = db.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => ok(req ? req.result : undefined); t.onerror = () => ko(t.error); t.onabort = () => ko(t.error || new Error("abort"));
    });
  },
  get(s, k) { return this.run(s, "readonly", st => st.get(k)); },
  put(s, k, v) { return this.run(s, "readwrite", st => st.put(v, k)); },
  del(s, k) { return this.run(s, "readwrite", st => st.delete(k)); },
  all(s) { return this.run(s, "readonly", st => st.getAll()); },
};
const S = { recs: [], units: [], docs: [], view: "home", rid: null, iid: null, draft: null, nombre: "", dev: "", urls: new Map(), paquete: null, borrarPaso: 0 };
const getRec = id => S.recs.find(r => r.id === id);
const unitsOf = (rid, iid) => S.units.filter(u => u.rid === rid && (iid === undefined || u.iid === iid)).sort((a, b) => a.en - b.en);
const docsOf = rid => S.docs.filter(d => d.rid === rid).sort((a, b) => a.en - b.en);
const itemOf = (rid, iid) => (getRec(rid)?.items || []).find(i => i.id === iid);

async function guardarFoto(blob) { const id = nid("f"); await DB.put("fotos", id, blob); return id; }
async function urlFoto(id) {
  if (!id) return "";
  if (S.urls.has(id)) return S.urls.get(id);
  const b = await DB.get("fotos", id).catch(() => null); if (!b) return "";
  const u = URL.createObjectURL(b); S.urls.set(id, u); return u;
}
async function hidratar(root = document) { for (const im of root.querySelectorAll("img[data-fid]")) { const u = await urlFoto(im.dataset.fid); if (u) im.src = u; } }

/* ============ GS1 / UDI y lector (zxing-cpp, mismo motor que la app principal) ============ */
const AI_FIJO = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
const AI3 = ["240", "241", "250", "251", "235", "422"], AI4 = ["7003", "8020", "8004"];
function parseGS1(t) {
  let s = String(t || "").trim(); const res = {};
  if (/^\(\d{2,4}\)/.test(s)) { const re = /\((\d{2,4})\)([^(]*)/g; let m; while ((m = re.exec(s))) res[m[1]] = m[2].trim(); return Object.keys(res).length ? res : null; }
  s = s.replace(/^\][A-Za-z]\d/, ""); const GS = "\x1d";
  if (!(/^0[01]\d{14}/.test(s) || (s.includes(GS) && /^\d{2}/.test(s)))) return null;
  let i = 0, guard = 0;
  while (i < s.length && guard++ < 25) {
    if (s[i] === GS) { i++; continue; }
    const ai2 = s.substr(i, 2);
    if (AI_FIJO[ai2]) { res[ai2] = s.substr(i + 2, AI_FIJO[ai2]); i += 2 + AI_FIJO[ai2]; continue; }
    const code = AI3.includes(s.substr(i, 3)) ? s.substr(i, 3) : AI4.includes(s.substr(i, 4)) ? s.substr(i, 4) : ai2;
    if (!/^\d+$/.test(code)) break;
    const st = i + code.length; let end = s.indexOf(GS, st); if (end < 0) end = s.length; res[code] = s.slice(st, end); i = end;
  }
  return Object.keys(res).length ? res : null;
}
function gtinValido(g) { if (!/^\d{8,14}$/.test(g || "")) return false; const d = g.split("").map(Number), c = d.pop(); const sum = d.reverse().reduce((a, v, i) => a + v * (i % 2 === 0 ? 3 : 1), 0); return (10 - sum % 10) % 10 === c; }
const fechaGS1 = v => (/^\d{6}$/.test(v || "") ? `20${v.slice(0, 2)}-${v.slice(2, 4)}-${v.slice(4, 6) === "00" ? "01" : v.slice(4, 6)}` : v || "");
function analizarCodigo(t) {
  const g = parseGS1(t);
  if (g && g["21"]) return { serie: g["21"], gtin: g["01"] || g["02"] || "", lote: g["10"] || "", fab: fechaGS1(g["11"]), venc: fechaGS1(g["17"]), ref: g["240"] || "", fuente: "GS1 AI(21)" };
  if (g) return { serie: "", gtin: g["01"] || g["02"] || "", lote: g["10"] || "", fab: fechaGS1(g["11"]), venc: fechaGS1(g["17"]), ref: g["240"] || "", fuente: "GS1 sin serie" };
  const s = String(t).trim();
  let m = s.match(/(?:^|\s)(?:S\/?N|SER(?:IAL)?(?:\s?NO\.?)?)[\s:#]*([A-Z0-9][A-Z0-9\-]{4,})/i);
  if (m) return { serie: m[1], fuente: "Texto S/N" };
  m = s.match(/^([A-Z0-9\-]{4,}) ([A-Z0-9]{1,3}) (\d{6,})$/);
  if (m) return { serie: m[3], ref: m[1], fuente: "P/N + S/N" };
  return { serie: "", fuente: /^\+/.test(s) ? "HIBC" : "" };
}
const pareceREF = (t, item) => { const n = normSerie(t), r = normSerie((item?.ref || "").replace(/^REF\s*/i, "")); return (r && (n === r || n.replace(/-/g, "") === r.replace(/-/g, ""))) || /^\d{3,4}-\d{3}-\d{3}$/.test(t) || /^W\/?O/i.test(t); };
function analizarTodos(codes, item) {
  const out = { serie: "", gtin: "", lote: "", fab: "", venc: "", fuente: "", candidatos: [] };
  for (const c of codes) { const a = analizarCodigo(c.t); if (a.serie && !out.serie) Object.assign(out, a); for (const k of ["gtin", "lote", "venc", "fab"]) if (a[k] && !out[k]) out[k] = a[k]; }
  for (const c of codes) { const a = analizarCodigo(c.t); if (!a.serie && !a.gtin && !pareceREF(c.t, item) && c.t.length >= 5 && c.t.length <= 30) out.candidatos.push(c.t); }
  return out;
}
let zxP = null, zxOK = false, bd = null;
function zxInit() {
  return zxP ||= (async () => {
    try { if ("BarcodeDetector" in window) { const f = await BarcodeDetector.getSupportedFormats(); if (f.length) bd = new BarcodeDetector({ formats: f }); } } catch { }
    if (!window.ZXingWASM) return !!bd;
    const ok = await Promise.race([
      ZXingWASM.prepareZXingModule({ overrides: { locateFile: (p, pre) => p.endsWith(".wasm") ? new URL("zxing_reader.wasm", location.href).href : pre + p }, fireImmediately: true }).then(() => true),
      sleep(20000).then(() => false),
    ]).catch(() => false);
    zxOK = !!ok; return zxOK || !!bd;
  })();
}
async function leerCodigos(bmp) {
  const found = new Map();
  if (!(await zxInit())) return found;
  const W = bmp.width, H = bmp.height, cv = document.createElement("canvas"), cx = cv.getContext("2d", { willReadFrequently: true });
  const pasada = async (sx, sy, sw, sh, maxDim) => {
    const sc = Math.min(maxDim / Math.max(sw, sh), 3), w = Math.max(1, Math.round(sw * sc)), h = Math.max(1, Math.round(sh * sc));
    cv.width = w; cv.height = h; cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    try {
      if (zxOK) { for (const x of await ZXingWASM.readBarcodes(cx.getImageData(0, 0, w, h), { tryHarder: true, tryRotate: true, textMode: "HRI", maxNumberOfSymbols: 8 })) if (x.isValid && x.text) found.set(x.text, x.format); }
      else if (bd) { for (const x of await bd.detect(cv)) if (x.rawValue) found.set(x.rawValue, x.format); }
    } catch (e) { console.warn(e); }
  };
  const tiene = () => [...found.keys()].some(t => analizarCodigo(t).serie);
  await pasada(0, 0, W, H, 2000); if (tiene()) return found;
  for (const n of [2, 3]) {
    const tw = Math.min(W, W / n * 1.5), th = Math.min(H, H / n * 1.5);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      await pasada(Math.max(0, Math.min(W - tw, j * W / n - (tw - W / n) / 2)), Math.max(0, Math.min(H - th, i * H / n - (th - H / n) / 2)), tw, th, 1400);
      if (tiene()) return found;
    }
  }
  return found;
}
async function abrirImagen(f) { try { return await createImageBitmap(f, { imageOrientation: "from-image" }); } catch { return await createImageBitmap(f); } }
async function comprimir(bmp, max = 1600, q = 0.82) {
  const sc = Math.min(1, max / Math.max(bmp.width, bmp.height)), cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc); cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
  return await new Promise(r => cv.toBlob(r, "image/jpeg", q));
}
/* Abre una foto, la guarda comprimida y lee sus códigos */
async function procesarFoto(file, item) {
  const bmp = await abrirImagen(file);
  const id = await guardarFoto(await comprimir(bmp));
  const codes = [...(await leerCodigos(bmp))].map(([t, f]) => ({ t, f }));
  bmp.close?.();
  return { id, codes, a: analizarTodos(codes, item) };
}

/* ============ vistas ============ */
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const esIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function render() {
  const v = { home: vHome, rec: vRec, item: vItem, unidad: vUnidad }[S.view] || vHome;
  $("#app").innerHTML = v();
  hidratar();
}
function barra(titulo, backTo) {
  return `<header class="top">${backTo ? `<button class="back" data-a="go" data-v="${backTo}" aria-label="Volver">‹ Volver</button>` : ""}<h1>${esc(titulo)}</h1>
  <span class="status" title="Lector de códigos">${zxOK || bd ? `<span class="dot ok"></span>Lector listo` : `<span class="dot"></span>Cargando lector`}</span></header>`;
}
function vHome() {
  const offline = S.swListo;
  return `${barra("Recepción en terreno")}
  <main class="wrap stack">
    ${!S.nombre ? `<section class="panel stack"><h3>Tu nombre</h3><div class="small muted">Aparece en cada unidad que registres.</div>
      <input type="text" id="nombre" placeholder="Nombre y apellido" autocomplete="name"><button class="btn primary" data-a="guardarNombre">Guardar</button></section>` :
      `<div class="row"><span class="muted">Registrando como <b>${esc(S.nombre)}</b></span><button class="btn sm" data-a="cambiarNombre">Cambiar</button></div>`}
    ${!standalone() ? `<section class="alert warn"><b>Instala la app antes de ir a bodega</b> (con internet):<br>${esIOS() ? "En Safari toca Compartir <b>⬆︎</b> → <b>Agregar a inicio</b>. Luego ábrela desde el ícono «Terreno»." : "Menú <b>⋮</b> → <b>Instalar app</b> o <b>Agregar a pantalla principal</b>. Luego ábrela desde el ícono."}</section>` : ""}
    <section class="panel stack"><h3>Listo para trabajar sin internet</h3>
      <div class="status"><span class="dot ${offline ? "ok" : ""}"></span>${offline ? "App guardada en el teléfono" : "Abre la app una vez con internet para guardarla"}</div>
      <div class="status"><span class="dot ${zxOK || bd ? "ok" : ""}"></span>${zxOK || bd ? "Lector de códigos listo" : "Preparando lector de códigos…"}</div>
      <div class="status"><span class="dot ${S.persist ? "ok" : ""}"></span>${S.persist ? "Datos protegidos en el teléfono" : "Datos guardados en el teléfono"}</div>
    </section>
    <section class="stack"><h3>Recepciones en este teléfono</h3>
      ${S.recs.length ? S.recs.sort((a, b) => b.creado - a.creado).map(r => {
        const n = unitsOf(r.id).length, q = (r.items || []).reduce((a, i) => a + (+i.cantidad || 0), 0);
        return `<button class="card" data-a="abrirRec" data-id="${esc(r.id)}"><div class="grow"><div class="t">${esc(r.nombre || "Recepción")}</div>
          <div class="s">${esc([r.proveedor, r.fecha].filter(Boolean).join(" · "))}</div>
          <div class="s">${r.enviado ? `<span class="chip ${r.enviadoN === n ? "ok" : "warn"}">Enviado ${hora(r.enviado)}${r.enviadoN !== n ? " · hay cambios sin enviar" : ""}</span>` : (n ? `<span class="chip warn">Sin enviar</span>` : "")}</div></div>
          <span class="count">${n}<small>${q ? " / " + q : ""}</small></span></button>`;
      }).join("") : `<div class="panel empty">Aún no hay recepciones. Carga el plan que te envió el coordinador.</div>`}
    </section>
    <section class="panel stack"><h3>Agregar recepción</h3>
      <label class="btn primary">Cargar archivo del plan<input type="file" accept=".json,.txt,application/json,text/plain" data-file="plan"></label>
      <details><summary>Pegar código del plan</summary><div class="stack">
        <div class="small muted">Si te enviaron el plan como texto (empieza con RPLAN), cópialo completo y pégalo aquí.</div>
        <textarea id="plancod" placeholder="RPLAN1:…"></textarea><button class="btn" data-a="pegarPlan">Cargar código</button></div></details>
      <details><summary>Recepción sin plan</summary><div class="stack">
        <input type="text" id="nr-nombre" placeholder="Nombre (ej. Stryker camas 17-nov)"><input type="text" id="nr-prov" placeholder="Proveedor">
        <button class="btn" data-a="nuevaRec">Crear</button></div></details>
    </section>
    <p class="small muted">Versión ${VERSION}. Las fotos y datos quedan solo en este teléfono hasta que envíes el paquete.</p>
  </main>`;
}
function vRec() {
  const r = getRec(S.rid); if (!r) { S.view = "home"; return vHome(); }
  const us = unitsOf(r.id), docs = docsOf(r.id), extras = us.filter(u => u.iid === "_extra").length;
  const sinEnviar = !r.enviado || r.enviadoN !== us.length || us.some(u => (u.mod || u.en) > r.enviado);
  return `${barra(r.nombre || "Recepción", "home")}
  <main class="wrap stack">
    <div><h2>${esc(r.nombre || "Recepción")}</h2><div class="muted small">${esc([r.proveedor, r.oc && "OC " + r.oc, r.guia && "Guía " + r.guia, r.lugar].filter(Boolean).join(" · "))}</div></div>
    <section class="stack"><h3>Documentos</h3>
      ${docs.length ? `<div class="thumbs">${docs.map(d => `<img data-fid="${esc(d.foto)}" alt="${esc(d.tipo)}">`).join("")}</div>` : ""}
      <div class="row"><label class="btn">Foto guía de despacho<input type="file" accept="image/*" capture="environment" data-file="doc" data-tipo="Guía de despacho"></label>
      <label class="btn">Foto OC<input type="file" accept="image/*" capture="environment" data-file="doc" data-tipo="Orden de compra"></label></div>
    </section>
    <section class="stack"><h3>Equipos</h3>
      ${(r.items || []).map((i, k) => {
        const n = unitsOf(r.id, i.id).length, q = +i.cantidad || 0;
        return `<button class="card" data-a="abrirItem" data-id="${esc(i.id)}"><div class="grow"><div class="t">${k + 1}. ${esc(i.equipo)}</div>
          <div class="s">${esc([i.marca, i.modelo, i.ref && "REF " + i.ref].filter(Boolean).join(" · "))}</div>
          ${(i.componentes || []).length ? `<div class="s">${i.componentes.length} accesorios</div>` : ""}</div>
          <span class="count ${q && n === q ? "done" : q && n > q ? "over" : ""}">${n}<small>${q ? " / " + q : ""}</small></span></button>`;
      }).join("") || `<div class="panel empty">Esta recepción no tiene lista de equipos. Usa «Equipo no listado».</div>`}
      <button class="card" data-a="abrirItem" data-id="_extra"><div class="grow"><div class="t">Equipo no listado</div><div class="s">Lo que llegó y no está en la lista</div></div><span class="count">${extras}</span></button>
    </section>
    <section class="panel stack"><h3>Quitar del teléfono</h3>
      <div class="small muted">Hazlo solo cuando el coordinador confirme que recibió el paquete.</div>
      ${S.borrarPaso ? `<div class="alert bad">Se borrarán ${us.length} unidades y sus fotos de este teléfono. ${sinEnviar ? "<b>Hay registros sin enviar.</b>" : ""}</div>
        <div class="row"><button class="btn danger" data-a="borrarRec">Sí, quitar</button><button class="btn" data-a="noBorrar">Cancelar</button></div>` : `<button class="btn danger" data-a="pedirBorrar">Quitar recepción del teléfono</button>`}
    </section>
  </main>
  <div class="foot"><div class="in"><button class="btn primary big" data-a="prepararPaquete" ${us.length || docs.length ? "" : "disabled"}>${S.paquete === "preparando" ? `<span class="spin"></span> Preparando…` : `Enviar paquete (${us.length})`}</button></div></div>`;
}
function vItem() {
  const r = getRec(S.rid), it = S.iid === "_extra" ? { id: "_extra", equipo: "Equipo no listado" } : itemOf(S.rid, S.iid);
  if (!r || !it) { S.view = "rec"; return vRec(); }
  const us = unitsOf(r.id, it.id), q = +it.cantidad || 0;
  return `${barra(it.equipo, "rec")}
  <main class="wrap stack">
    <div><h2>${esc(it.equipo)}</h2><div class="muted small">${esc([it.marca, it.modelo, it.ref && "REF " + it.ref, it.recinto].filter(Boolean).join(" · "))}</div>
    <div class="small" style="margin-top:4px"><b>${us.length}</b>${q ? ` de ${q}` : ""} unidades registradas</div></div>
    ${(it.componentes || []).length ? `<div class="small muted">Cada unidad debe traer: ${esc(it.componentes.join(", "))}</div>` : ""}
    ${us.map((u, k) => {
      const falt = (u.comps || []).filter(c => !c.ok).length;
      return `<button class="card" data-a="editarUnidad" data-id="${esc(u.id)}">${u.foto ? `<img class="thumb" data-fid="${esc(u.foto)}" alt="">` : `<span class="thumb"></span>`}
        <div class="grow"><div class="t ${u.serie ? "mono" : ""}">${u.serie ? esc(u.serie) : "Sin serie"}</div>
        <div class="s">${u.equipo ? esc(u.equipo) + " · " : ""}${esc(hora(u.en))}</div>
        <div class="row" style="gap:4px;margin-top:4px">${u.metodo === "codigo" ? `<span class="chip ok">leída del código</span>` : u.serie ? `<span class="chip">escrita</span>` : `<span class="chip warn">sin serie</span>`}
        ${falt ? `<span class="chip warn">faltan ${falt}</span>` : ""}${u.estado && u.estado !== "conforme" ? `<span class="chip ${u.estado === "rechazado" ? "bad" : "warn"}">${ESTADOS[u.estado]}</span>` : ""}</div></div></button>`;
    }).join("") || `<div class="panel empty">Sin unidades todavía.</div>`}
  </main>
  <div class="foot"><div class="in"><label class="btn primary big">Fotografiar placa de unidad nueva<input type="file" accept="image/*" capture="environment" data-file="nueva"></label></div></div>`;
}
function avisos(d) {
  const av = [];
  if (d.leyendo) return av;
  if (!d.serie) av.push(["warn", d.foto ? "No se encontró la serie en un código. Escríbela desde la placa o toma otra foto más cerca." : "Toma la foto de la placa."]);
  if (d.gtin && !gtinValido(d.gtin)) av.push(["bad", `El GTIN ${d.gtin} no cumple el dígito verificador: posible mala lectura.`]);
  if (d.serie && /^W\/?O|^LOT|^REF/i.test(d.serie)) av.push(["bad", "Esto parece orden de trabajo, lote o REF, no una serie."]);
  if (d.serie && d.metodo === "codigo" && d.fuente && !/AI\(21\)|S\/N/.test(d.fuente)) av.push(["warn", "Confirma con la placa que este valor es la serie."]);
  const n = normSerie(d.serie);
  if (n) { const dup = S.units.find(u => u.id !== d.id && normSerie(u.serie) === n); if (dup) av.push(["bad", `Serie ya registrada en este teléfono (${esc(dup.equipo || itemOf(dup.rid, dup.iid)?.equipo || "otra unidad")}, ${hora(dup.en)}).`]); }
  if (d.venc && d.venc < hoy()) av.push(["bad", `Vencido (${d.venc}).`]);
  return av;
}
function vUnidad() {
  const d = S.draft; if (!d) { S.view = "item"; return vItem(); }
  const it = d.iid === "_extra" ? null : itemOf(d.rid, d.iid);
  const falt = d.comps.filter(c => !c.ok).length;
  return `${barra(d.nuevo ? "Unidad nueva" : "Editar unidad", null)}
  <main class="wrap stack" id="form">
    <div><div class="muted small">${esc(it ? it.equipo : "Equipo no listado")}</div>${it ? `<div class="small muted">${esc([it.marca, it.modelo, it.ref && "REF " + it.ref].filter(Boolean).join(" · "))}</div>` : ""}</div>
    ${!it ? `<div><label class="f" for="u-equipo">¿Qué equipo es?</label><input type="text" id="u-equipo" data-f="equipo" value="${esc(d.equipo || "")}" placeholder="Ej. Monitor de signos vitales"></div>` : ""}
    <section class="panel stack"><h3>Placa del equipo</h3>
      ${d.foto ? `<img class="foto" data-fid="${esc(d.foto)}" alt="Foto de la placa">` : ""}
      <label class="btn ${d.foto ? "" : "primary big"}">${d.foto ? "Tomar otra foto" : "Fotografiar placa"}<input type="file" accept="image/*" capture="environment" data-file="placa"></label>
      ${d.leyendo ? `<div class="alert"><span class="spin"></span> Leyendo código…</div>` : ""}
      <div><label class="f" for="u-serie">Número de serie ${d.metodo === "codigo" ? `<span class="chip ok">leída del código</span>` : d.serie ? `<span class="chip">escrita</span>` : ""}</label>
        <input type="text" id="u-serie" class="serie" data-f="serie" value="${esc(d.serie)}" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="Escribe la serie si no se leyó"></div>
      ${d.candidatos?.length && !d.serie ? `<div class="small">Otros códigos leídos: ${d.candidatos.map(c => `<button class="btn sm" data-a="usarCand" data-v="${esc(c)}">${esc(c)}</button>`).join(" ")}</div>` : ""}
      ${(d.gtin || d.lote || d.fab || d.venc) ? `<div class="gs1">${d.gtin ? `<div><span>GTIN</span><b>${esc(d.gtin)}</b></div>` : ""}${d.lote ? `<div><span>Lote</span><b>${esc(d.lote)}</b></div>` : ""}${d.fab ? `<div><span>Fabricación</span><b>${esc(d.fab)}</b></div>` : ""}${d.venc ? `<div><span>Vence</span><b>${esc(d.venc)}</b></div>` : ""}</div>` : ""}
      ${avisos(d).map(([k, m]) => `<div class="alert ${k}">${m}</div>`).join("")}
    </section>
    <section class="panel stack"><h3>Accesorios ${d.comps.length ? `<span class="chip ${falt ? "warn" : "ok"}">${falt ? `faltan ${falt}` : "completos"}</span>` : ""}</h3>
      ${d.comps.map((c, k) => `<div class="comp ${c.ok ? "" : "falta"}"><div class="cl"><label class="cbx"><input type="checkbox" data-ck="${k}" ${c.ok ? "checked" : ""}>${esc(c.nombre)}</label>
        <label class="btn sm">${c.foto ? "Otra foto" : "Foto"}<input type="file" accept="image/*" capture="environment" data-file="comp" data-k="${k}"></label></div>
        ${c.leyendo ? `<div class="small"><span class="spin"></span> Leyendo…</div>` : ""}
        ${c.foto ? `<div class="row"><img class="thumb" data-fid="${esc(c.foto)}" alt=""><input type="text" class="mono" data-cs="${k}" value="${esc(c.serie || "")}" placeholder="Serie o código del accesorio" style="flex:1;min-width:0"></div>` : ""}
        ${c.gtin || c.lote ? `<div class="small muted mono">${esc([c.gtin && "GTIN " + c.gtin, c.lote && "Lote " + c.lote].filter(Boolean).join(" · "))}</div>` : ""}</div>`).join("") || `<div class="small muted">Este equipo no tiene accesorios en el plan.</div>`}
      <div class="row"><input type="text" id="u-newcomp" placeholder="Otro accesorio (ej. cable de poder)" style="flex:1;min-width:0"><button class="btn sm" data-a="addComp">Agregar</button></div>
    </section>
    <section class="panel stack"><h3>Inspección</h3>
      ${CHECKS.map(([k, t]) => `<label class="cbx"><input type="checkbox" data-chk="${k}" ${d.checks[k] !== false ? "checked" : ""}>${t}</label>`).join("")}
      <div class="seg" role="radiogroup" aria-label="Resultado">${Object.entries(ESTADOS).map(([k, t]) => `<label><input type="radio" name="estado" value="${k}" ${d.estado === k ? "checked" : ""}><span>${t}</span></label>`).join("")}</div>
      <div><label class="f" for="u-obs">Observación</label><textarea id="u-obs" data-f="obs" placeholder="Daño, embalaje, lo que falte">${esc(d.obs || "")}</textarea></div>
      <div class="thumbs">${d.extra.map(f => `<img data-fid="${esc(f)}" alt="Foto adicional">`).join("")}</div>
      <label class="btn">Foto de daño o embalaje<input type="file" accept="image/*" capture="environment" data-file="extra"></label>
    </section>
    ${!d.nuevo ? `<button class="btn danger" data-a="${d.borrar ? "borrarUnidad" : "pedirBorrarU"}">${d.borrar ? "Toca otra vez para eliminar esta unidad" : "Eliminar unidad"}</button>` : ""}
  </main>
  <div class="foot"><div class="in">
    <button class="btn" data-a="cancelar">Cancelar</button>
    <button class="btn primary" data-a="guardarU" ${d.leyendo ? "disabled" : ""}>Guardar</button>
    ${d.nuevo ? `<label class="btn primary" ${d.leyendo ? 'aria-disabled="true"' : ""}>Guardar y otra<input type="file" accept="image/*" capture="environment" data-file="siguiente" ${d.leyendo ? "disabled" : ""}></label>` : ""}
  </div></div>`;
}

/* ============ borrador (sobrevive si el teléfono recarga la página al abrir la cámara) ============ */
let draftT;
function guardarDraft(ahora) {
  clearTimeout(draftT);
  const go = () => DB.put("kv", "draft", S.draft ? JSON.parse(JSON.stringify({ ...S.draft, leyendo: false, comps: S.draft.comps.map(c => ({ ...c, leyendo: false })) })) : null).catch(() => { });
  if (ahora) return go(); draftT = setTimeout(go, 250);
}
addEventListener("pagehide", () => { if (S.draft) guardarDraft(true); });
document.addEventListener("visibilitychange", () => { if (document.hidden && S.draft) guardarDraft(true); });
function leerForm() {
  const d = S.draft; if (!d || !$("#form")) return;
  const s = $("#u-serie"); if (s) { const v = s.value.trim(); if (normSerie(v) !== normSerie(d.serie)) { d.serie = v; d.metodo = v ? "manual" : "pendiente"; } }
  const e = $("#u-equipo"); if (e) d.equipo = e.value.trim();
  const o = $("#u-obs"); if (o) d.obs = o.value.trim();
  document.querySelectorAll("[data-chk]").forEach(c => d.checks[c.dataset.chk] = c.checked);
  document.querySelectorAll("[data-ck]").forEach(c => d.comps[+c.dataset.ck].ok = c.checked);
  document.querySelectorAll("[data-cs]").forEach(c => { const cp = d.comps[+c.dataset.cs]; const v = c.value.trim(); if (v !== (cp.serie || "")) { cp.serie = v; cp.metodo = v ? "manual" : ""; } });
  if (!d.estadoManual) d.estado = (d.comps.some(c => !c.ok) || Object.values(d.checks).some(v => v === false)) ? "observado" : "conforme";
}
function nuevaUnidad(iid) {
  const it = iid === "_extra" ? null : itemOf(S.rid, iid);
  return { id: nid("u"), rid: S.rid, iid, nuevo: true, equipo: "", serie: "", gtin: "", lote: "", fab: "", venc: "", metodo: "pendiente", fuente: "", codigos: [], candidatos: [],
    foto: null, extra: [], comps: (it?.componentes || []).map(n => ({ nombre: n, ok: true })), checks: Object.fromEntries(CHECKS.map(c => [c[0], true])), estado: "conforme", obs: "", por: S.nombre, en: Date.now() };
}
async function fotoPlaca(file) {
  const d = S.draft; d.leyendo = true; render();
  try {
    const it = d.iid === "_extra" ? null : itemOf(d.rid, d.iid);
    const { id, codes, a } = await procesarFoto(file, it);
    if (S.draft !== d) return;
    d.foto = id; d.codigos = codes.slice(0, 10); d.candidatos = a.candidatos;
    Object.assign(d, { gtin: a.gtin, lote: a.lote, fab: a.fab, venc: a.venc, fuente: a.fuente });
    if (a.serie) { d.serie = a.serie; d.metodo = "codigo"; if (navigator.vibrate) navigator.vibrate(60); }
    else if (d.metodo === "codigo") { d.serie = ""; d.metodo = "pendiente"; }
  } catch (e) { console.warn(e); toast("No se pudo abrir la foto. Intenta de nuevo."); }
  d.leyendo = false; await guardarDraft(true); if (S.draft === d && S.view === "unidad") render();
}
async function fotoComp(file, k) {
  const d = S.draft, c = d.comps[k]; c.leyendo = true; render();
  try {
    const { id, codes, a } = await procesarFoto(file, null);
    c.foto = id; c.codigos = codes.slice(0, 6); c.ok = true; c.gtin = a.gtin || ""; c.lote = a.lote || "";
    if (a.serie) { c.serie = a.serie; c.metodo = "codigo"; } else if (!c.serie && a.candidatos[0]) { c.serie = a.candidatos[0]; c.metodo = "codigo_texto"; }
  } catch (e) { toast("No se pudo abrir la foto."); }
  c.leyendo = false; await guardarDraft(true); if (S.draft === d) render();
}
async function guardarUnidad() {
  leerForm(); const d = S.draft; if (!d || d.leyendo) return false;
  if (!d.foto && !d.serie) { toast("Toma la foto de la placa o escribe la serie."); return false; }
  const u = { ...d }; delete u.nuevo; delete u.leyendo; delete u.borrar; delete u.estadoManual; delete u.candidatos;
  u.comps = u.comps.map(c => { const x = { ...c }; delete x.leyendo; return x; });
  u.serie = (u.serie || "").trim(); if (!u.serie) u.metodo = "pendiente";
  u.mod = Date.now();
  await DB.put("units", u.id, u);
  const i = S.units.findIndex(x => x.id === u.id); if (i >= 0) S.units[i] = u; else S.units.push(u);
  S.draft = null; await DB.put("kv", "draft", null);
  toast(u.serie ? `Guardada ${u.serie}` : "Guardada sin serie");
  return true;
}

/* ============ plan y paquete ============ */
async function b64aTexto(b64, comprimido) {
  const bytes = Uint8Array.from(atob(b64.replace(/\s+/g, "")), c => c.charCodeAt(0));
  if (!comprimido) return new TextDecoder().decode(bytes);
  const ds = new DecompressionStream("deflate-raw");
  return await new Response(new Blob([bytes]).stream().pipeThrough(ds)).text();
}
async function cargarPlanTexto(txt) {
  txt = String(txt || "").trim();
  let obj;
  try {
    const m = txt.match(/RPLAN([01]):([A-Za-z0-9+/=\s]+)/);
    obj = JSON.parse(m ? await b64aTexto(m[2], m[1] === "1") : txt);
  } catch { toast("El archivo o código del plan no es válido."); return; }
  if (obj.formato !== "recepcion-plan" || !obj.rec) { toast("Esto no es un plan de recepción."); return; }
  const prev = getRec(obj.rec.id);
  const rec = { ...(prev || {}), ...obj.rec, items: obj.items || [], origen: "plan", creado: prev?.creado || Date.now(), planCargado: Date.now() };
  await DB.put("recs", rec.id, rec);
  S.recs = S.recs.filter(r => r.id !== rec.id).concat(rec);
  S.rid = rec.id; S.view = "rec"; render();
  toast(prev ? "Plan actualizado (tus registros se mantienen)" : `Plan cargado: ${rec.items.length} equipos`, 3500);
}
async function prepararPaquete() {
  const r = getRec(S.rid); if (!r || S.paquete) return;
  S.paquete = "preparando"; render();
  try {
    const us = unitsOf(r.id), docs = docsOf(r.id), zip = new JSZip(), fotos = new Set();
    for (const u of us) { if (u.foto) fotos.add(u.foto); (u.extra || []).forEach(f => fotos.add(f)); (u.comps || []).forEach(c => c.foto && fotos.add(c.foto)); }
    docs.forEach(d => fotos.add(d.foto));
    let faltan = 0;
    for (const f of fotos) { const b = await DB.get("fotos", f).catch(() => null); if (b) zip.file(`fotos/${f}.jpg`, b); else faltan++; }
    const rec = { id: r.id, nombre: r.nombre, proveedor: r.proveedor || "", fecha: r.fecha || "", oc: r.oc || "", guia: r.guia || "", lugar: r.lugar || "", origen: r.origen };
    zip.file("terreno.json", JSON.stringify({ formato: "recepcion-terreno", version: 1, app: VERSION, rec, items: r.origen === "plan" ? [] : r.items || [], por: S.nombre, dispositivo: S.dev, exportado: Date.now(), unidades: us, documentos: docs }, null, 1));
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const d = new Date(), st = `${hoy()}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    const name = `Terreno_${slug(r.nombre)}_${slug(S.nombre)}_${st}.zip`;
    S.paquete = { file: new File([blob], name, { type: "application/zip" }), n: us.length, docs: docs.length, mb: blob.size / 1048576, faltan };
  } catch (e) { console.warn(e); S.paquete = null; toast("No se pudo armar el paquete: " + (e.message || e)); render(); return; }
  hojaPaquete();
}
function hojaPaquete() {
  const p = S.paquete, puedeCompartir = navigator.canShare && navigator.canShare({ files: [p.file] });
  $("#app").insertAdjacentHTML("beforeend", `<div class="foot" id="hoja" style="top:auto;box-shadow:0 -8px 30px rgba(0,0,0,.2)"><div class="stack" style="max-width:720px;margin:0 auto">
    <h3>Paquete listo</h3>
    <div class="small">${p.n} unidades${p.docs ? ` y ${p.docs} documentos` : ""} · ${p.mb.toFixed(1)} MB<br><span class="muted mono">${esc(p.file.name)}</span></div>
    ${p.faltan ? `<div class="alert warn">${p.faltan} fotos no se encontraron en el teléfono.</div>` : ""}
    <div class="small muted">Envíalo al coordinador por WhatsApp <b>como documento</b>, OneDrive o correo. Guárdalo también en el teléfono por si acaso.</div>
    ${puedeCompartir ? `<button class="btn primary big" data-a="compartir">Compartir (WhatsApp, OneDrive, correo…)</button>` : ""}
    <button class="btn ${puedeCompartir ? "" : "primary big"}" data-a="descargar">Guardar en el teléfono</button>
    <button class="btn" data-a="cerrarPaquete">Cerrar</button></div></div>`);
}
async function marcarEnviado() { const r = getRec(S.rid); r.enviado = Date.now(); r.enviadoN = S.paquete.n; await DB.put("recs", r.id, r); }

/* ============ acciones ============ */
const A = {
  go(ds) { S.view = ds.v; S.borrarPaso = 0; render(); scrollTo(0, 0); },
  async guardarNombre() { const v = $("#nombre").value.trim(); if (!v) return toast("Escribe tu nombre."); S.nombre = v; await DB.put("kv", "nombre", v); render(); },
  async cambiarNombre() { S.nombre = ""; render(); },
  abrirRec(ds) { S.rid = ds.id; S.view = "rec"; S.borrarPaso = 0; render(); scrollTo(0, 0); },
  abrirItem(ds) { S.iid = ds.id; S.view = "item"; render(); scrollTo(0, 0); },
  pegarPlan() { cargarPlanTexto($("#plancod").value); },
  async nuevaRec() {
    const n = $("#nr-nombre").value.trim(); if (!n) return toast("Ponle un nombre.");
    const r = { id: nid("rt"), nombre: n, proveedor: $("#nr-prov").value.trim(), fecha: hoy(), items: [], origen: "terreno", creado: Date.now() };
    await DB.put("recs", r.id, r); S.recs.push(r); S.rid = r.id; S.view = "rec"; render();
  },
  editarUnidad(ds) { const u = S.units.find(x => x.id === ds.id); if (!u) return; S.draft = JSON.parse(JSON.stringify(u)); S.draft.estadoManual = true; S.draft.candidatos = []; S.view = "unidad"; render(); scrollTo(0, 0); },
  usarCand(ds) { leerForm(); S.draft.serie = ds.v; S.draft.metodo = "codigo_texto"; guardarDraft(); render(); },
  addComp() { leerForm(); const v = $("#u-newcomp").value.trim(); if (!v) return; S.draft.comps.push({ nombre: v, ok: true, extra: true }); guardarDraft(); render(); },
  async guardarU() { if (await guardarUnidad()) { S.view = "item"; render(); scrollTo(0, 0); } },
  async cancelar() { S.draft = null; await DB.put("kv", "draft", null); S.view = "item"; render(); },
  pedirBorrarU() { leerForm(); S.draft.borrar = true; render(); },
  async borrarUnidad() { const id = S.draft.id; await DB.del("units", id); S.units = S.units.filter(u => u.id !== id); S.draft = null; await DB.put("kv", "draft", null); S.view = "item"; render(); toast("Unidad eliminada"); },
  prepararPaquete() { prepararPaquete(); },
  async compartir() {
    try { await navigator.share({ files: [S.paquete.file], title: S.paquete.file.name }); await marcarEnviado(); toast("Paquete compartido"); }
    catch (e) { if (e.name !== "AbortError") toast("No se pudo compartir. Usa «Guardar en el teléfono»."); }
  },
  async descargar() {
    const a = document.createElement("a"), u = URL.createObjectURL(S.paquete.file); a.href = u; a.download = S.paquete.file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000); await marcarEnviado(); toast("Archivo guardado. Revisa Descargas o Archivos.", 4000);
  },
  cerrarPaquete() { S.paquete = null; render(); },
  pedirBorrar() { S.borrarPaso = 1; render(); },
  noBorrar() { S.borrarPaso = 0; render(); },
  async borrarRec() {
    const rid = S.rid, us = unitsOf(rid), docs = docsOf(rid);
    for (const u of us) { for (const f of [u.foto, ...(u.extra || []), ...(u.comps || []).map(c => c.foto)]) if (f) await DB.del("fotos", f).catch(() => { }); await DB.del("units", u.id); }
    for (const d of docs) { await DB.del("fotos", d.foto).catch(() => { }); await DB.del("docs", d.id); }
    await DB.del("recs", rid);
    S.units = S.units.filter(u => u.rid !== rid); S.docs = S.docs.filter(d => d.rid !== rid); S.recs = S.recs.filter(r => r.id !== rid);
    S.borrarPaso = 0; S.view = "home"; render(); toast("Recepción quitada del teléfono");
  },
};
document.addEventListener("click", e => {
  const el = e.target.closest("[data-a]"); if (!el || el.tagName === "LABEL") return;
  const f = A[el.dataset.a]; if (!f || el.disabled) return; e.preventDefault(); f(el.dataset, el);
});
document.addEventListener("input", e => { if (S.view === "unidad" && e.target.closest("#form")) { leerForm(); guardarDraft(); } });
document.addEventListener("change", async e => {
  const t = e.target;
  if (S.view === "unidad" && t.name === "estado") { leerForm(); S.draft.estado = t.value; S.draft.estadoManual = true; guardarDraft(); render(); return; }
  if (S.view === "unidad" && t.closest("#form") && !t.dataset.file) { leerForm(); guardarDraft(); if (t.dataset.ck !== undefined || t.name === "estado" || t.dataset.chk) render(); return; }
  if (!t.dataset.file || !t.files?.length) return;
  const files = [...t.files], k = t.dataset.file; t.value = "";
  if (k === "plan") { cargarPlanTexto(await files[0].text()); }
  else if (k === "doc") {
    try { const id = await guardarFoto(await comprimir(await abrirImagen(files[0]))); const d = { id: nid("d"), rid: S.rid, tipo: t.dataset.tipo || "Documento", foto: id, en: Date.now(), por: S.nombre }; await DB.put("docs", d.id, d); S.docs.push(d); render(); toast("Documento guardado"); }
    catch { toast("No se pudo abrir la foto."); }
  }
  else if (k === "nueva") { S.draft = nuevaUnidad(S.iid); guardarDraft(true); S.view = "unidad"; render(); scrollTo(0, 0); fotoPlaca(files[0]); }
  else if (k === "placa") { leerForm(); fotoPlaca(files[0]); }
  else if (k === "comp") { leerForm(); fotoComp(files[0], +t.dataset.k); }
  else if (k === "extra") { leerForm(); try { const id = await guardarFoto(await comprimir(await abrirImagen(files[0]))); S.draft.extra.push(id); guardarDraft(); render(); } catch { toast("No se pudo abrir la foto."); } }
  else if (k === "siguiente") { const iid = S.draft.iid; if (await guardarUnidad()) { S.draft = nuevaUnidad(iid); S.view = "unidad"; render(); scrollTo(0, 0); fotoPlaca(files[0]); } }
});

/* ============ arranque ============ */
(async function boot() {
  try {
    const [recs, units, docs, nombre, dev, draft] = await Promise.all([DB.all("recs"), DB.all("units"), DB.all("docs"), DB.get("kv", "nombre"), DB.get("kv", "dev"), DB.get("kv", "draft")]);
    Object.assign(S, { recs, units, docs, nombre: nombre || "" });
    S.dev = dev || nid("dev"); if (!dev) DB.put("kv", "dev", S.dev);
    if (draft && getRec(draft.rid)) { S.draft = draft; S.rid = draft.rid; S.iid = draft.iid; S.view = "unidad"; setTimeout(() => toast("Recuperé la unidad que estabas registrando", 3500), 300); }
  } catch (e) { $("#app").innerHTML = `<div class="wrap"><div class="alert bad">Este navegador no permite guardar datos (¿modo privado?). Abre la app normal, no en incógnito.</div></div>`; return; }
  render();
  zxInit().then(() => { if (S.view !== "unidad") render(); });
  try { S.persist = await navigator.storage?.persist?.(); } catch { }
  if ("serviceWorker" in navigator) {
    try {
      const reg = await navigator.serviceWorker.register("sw.js");
      await navigator.serviceWorker.ready; S.swListo = true; if (S.view === "home") render();
      if (navigator.onLine) reg.update().catch(() => { });
    } catch (e) { console.warn(e); }
  }
})();
