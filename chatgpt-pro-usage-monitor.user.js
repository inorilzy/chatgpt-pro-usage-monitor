// ==UserScript==
// @name         ChatGPT Pro 用量估算器（GPT-6 / GPT-5.6 Sol Pro）
// @namespace    https://chatgpt.com/
// @version      1.2.9
// @description  发送时立即暂记，模型元数据到达就确认/纠正，不等回复完成；并发请求持久账本、失败回退、缩放记忆。本机非官方估算。
// @author       ChatGPT-generated (unofficial)
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  'use strict';

  // Protocol-field references (independent implementation, no upstream code bundled):
  // zjm54321/chatgpt-scripts : server_ste_metadata + user-message-bound telemetry
  // CwithW/gpt-web-routing-detect-tampermonkey : resolved_model_slug vs model_slug
  const APP_ID = 'chatgpt-pro-usage-estimator';
  const VERSION = '1.2.9';
  const STORAGE_KEY = `${APP_ID}:state:v1`;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;
  const RETENTION_MS = 60 * DAY_MS;
  const MAX_LOGS = 240;
  const HOOK_STATE_KEY = '__CHATGPT_PRO_USAGE_ESTIMATOR_HOOK_V2__';
  const HOOK_EVENT_SOURCE = 'chatgpt-pro-usage-estimator-hook-v2';
  const UI_OWNER_KEY = '__CHATGPT_PRO_USAGE_ESTIMATOR_UI_OWNER_V2__';

  const DEFAULT_SETTINGS = Object.freeze({
    plan: 'pro200',
    dayWindow: 'rolling24',
    weekWindow: 'rolling7',
    countingMode: 'request-first',
    collapsed: false,
    hidden: false,
    position: null,
    panelScale: 1,
  });

  const channel = `${APP_ID}:${cryptoRandomId()}`;
  let state = loadState();
  let savedBaseline = persistedBaseline();
  let host = null;
  let shadow = null;
  let renderTimer = null;
  let saveTimer = null;
  let uiObserver = null;
  let ui = {
    view: 'main',
    calibration: null,
    toast: null,
    toastTimer: null,
    menuOpen: false,
    hookReady: false,
    hookVersion: '',
    lastRequestAt: 0,
    inFlight: new Map(),
    pointerBusy: false,
    renderQueued: false,
    modelSwitch: '',
  };

  claimUiOwnership();
  listenForHookEvents();
  installNetworkHook();
  installStorageSync();
  installMenuCommands();
  bootUi();
  // Persist migration/recovered journals immediately; baseline excludes unsaved recovery.
  saveStateNow();

  function cryptoRandomId() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {
      // Ignore and use the fallback below.
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function parseStored(value) {
    if (value == null) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch (_) {
        return null;
      }
    }
    return value;
  }

  function loadState() {
    let stored = null;
    try {
      stored = parseStored(GM_getValue(STORAGE_KEY, null));
    } catch (error) {
      console.warn(`[${APP_ID}] 读取存储失败`, error);
    }

    const next = {
      schemaVersion: 5,
      records: [],
      pending: [],
      logs: [],
      settings: { ...DEFAULT_SETTINGS },
    };

    if (stored && typeof stored === 'object') {
      if (Array.isArray(stored.records)) {
        next.records = stored.records.map(normalizeRecord).filter(Boolean);
      }
      if (Array.isArray(stored.pending)) {
        next.pending = stored.pending.map(normalizePending).filter(Boolean);
      }
      if (Array.isArray(stored.logs)) {
        next.logs = stored.logs.map(normalizeLog).filter(Boolean).slice(-MAX_LOGS);
      }
      if (stored.settings && typeof stored.settings === 'object') {
        next.settings = normalizeSettings(stored.settings);
      }
      // v1.2 adds the GPT-5.6 Pro daily-limit card. Expand once after upgrading
      // so the new allowance is visible without discarding existing counts.
      if (Number(stored.schemaVersion || 1) < 3) {
        next.settings.collapsed = false;
      }
    }

    recoverRequestJournals(next);
    pruneOldData(next);
    return next;
  }

  function persistedBaseline() {
    let raw = null;
    try { raw = parseStored(GM_getValue(STORAGE_KEY, null)); } catch (_) {}
    return {
      schemaVersion: 5,
      records: Array.isArray(raw?.records) ? raw.records.map(normalizeRecord).filter(Boolean) : [],
      pending: Array.isArray(raw?.pending) ? raw.pending.map(normalizePending).filter(Boolean) : [],
      logs: Array.isArray(raw?.logs) ? raw.logs.map(normalizeLog).filter(Boolean) : [],
      settings: normalizeSettings(raw?.settings || {}),
    };
  }

  function normalizeSettings(raw) {
    const plan = raw.plan === 'pro100' ? 'pro100' : 'pro200';
    const dayWindow = raw.dayWindow === 'localDay' ? 'localDay' : 'rolling24';
    const weekWindow = raw.weekWindow === 'localWeek' ? 'localWeek' : 'rolling7';
    // v1.2.5's inferenceMode meant wait-until-finished, not this setting.
    // Upgrade defaults to the newly approved request-first policy.
    const countingMode = raw.countingMode === 'model-first' ? 'model-first' : 'request-first';
    const position = raw.position && Number.isFinite(raw.position.left) && Number.isFinite(raw.position.top)
      ? { left: Number(raw.position.left), top: Number(raw.position.top) }
      : null;

    return {
      plan,
      dayWindow,
      weekWindow,
      countingMode,
      collapsed: raw.collapsed == null ? false : Boolean(raw.collapsed),
      hidden: raw.hidden == null ? false : Boolean(raw.hidden),
      position,
      panelScale: normalizePanelScale(raw.panelScale),
    };
  }

  // Store the preferred scale, not a viewport-clamped transient value.
  function normalizePanelScale(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.max(0.7, Math.min(1.6, n)) : 1;
  }

  function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.model !== 'gpt6' && raw.model !== 'solpro') return null;
    const ts = Number(raw.ts);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return {
      id: String(raw.id || cryptoRandomId()),
      ts,
      model: raw.model,
      status: ['provisional','confirmed','manual','legacy'].includes(raw.status) ? raw.status : (raw.source === 'manual' || raw.source === 'calibration' ? 'manual' : 'legacy'),
      updatedAt: Number(raw.updatedAt) || ts,
      source: String(raw.source || 'unknown'),
      confidence: String(raw.confidence || 'unknown'),
      requestId: String(raw.requestId || ''),
      eventKey: raw.eventKey ? String(raw.eventKey) : '',
      assistantId: raw.assistantId ? String(raw.assistantId) : '',
      conversationId: raw.conversationId ? String(raw.conversationId) : '',
      requestedModel: raw.requestedModel ? String(raw.requestedModel).slice(0, 160) : '',
      rawModel: raw.rawModel ? String(raw.rawModel).slice(0, 160) : '',
      modelEvidence: String(raw.modelEvidence || '').slice(0, 240),
      route: raw.route ? String(raw.route).slice(0, 240) : '',
    };
  }

  function normalizeLog(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const ts = Number(raw.ts);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return {
      id: String(raw.id || cryptoRandomId()),
      ts,
      result: String(raw.result || 'unknown'),
      reason: String(raw.reason || '').slice(0, 240),
      requestedModel: String(raw.requestedModel || '').slice(0, 160),
      actualModel: String(raw.actualModel || '').slice(0, 160),
      actualModelPath: String(raw.actualModelPath || '').slice(0, 240),
      requestId: String(raw.requestId || '').slice(0, 160),
      conversationId: String(raw.conversationId || '').slice(0, 160),
      requestUrlPath: String(raw.requestUrlPath || '').slice(0, 240),
      transport: String(raw.transport || '').slice(0, 40),
      confidence: String(raw.confidence || ''),
      route: String(raw.route || '').slice(0, 240),
      eventKey: String(raw.eventKey || ''),
    };
  }

  function pruneOldData(targetState = state) {
    const cutoff = Date.now() - RETENTION_MS;
    // Keep terminal requests as deduplication/correction tombstones, not only unfinished ones.
    targetState.pending = (targetState.pending || []).filter(p => p.startedAt >= cutoff).slice(-20000);
    targetState.records = targetState.records.filter((record) => record.ts >= cutoff);
    targetState.logs = targetState.logs.filter((log) => log.ts >= cutoff).slice(-MAX_LOGS);
  }

  function cloneState(value) { return JSON.parse(JSON.stringify(value)); }
  function mergeList(base, local, remote, key = 'id') {
    const b = new Map((base || []).map(x => [x[key], x]));
    const l = new Map((local || []).map(x => [x[key], x]));
    const result = new Map((remote || []).map(x => [x[key], x]));
    for (const id of b.keys()) if (!l.has(id)) result.delete(id);
    for (const [id, value] of l) if (!b.has(id) || JSON.stringify(value) !== JSON.stringify(b.get(id))) result.set(id, value);
    return [...result.values()];
  }
  function mergeState(base, local, remote) {
    const merged = {
      schemaVersion: 5,
      records: mergeList(base.records, local.records, remote.records).map(normalizeRecord).filter(Boolean),
      logs: mergeList(base.logs, local.logs, remote.logs).map(normalizeLog).filter(Boolean).sort((a,b) => a.ts-b.ts).slice(-MAX_LOGS),
      pending: mergeList(base.pending, local.pending, remote.pending).map(normalizePending).filter(Boolean),
      settings: { ...normalizeSettings(remote.settings || {}) },
    };
    for (const k of Object.keys(local.settings)) {
      if (JSON.stringify(local.settings[k]) !== JSON.stringify(base.settings[k])) merged.settings[k] = local.settings[k];
    }
    const seen = new Set();
    merged.records = merged.records.filter(r => {
      const key = r.eventKey || r.id; if (seen.has(key)) return false; seen.add(key); return true;
    });
    const ledger = new Map(merged.pending.map(p => [p.requestId, p]));
    merged.records = merged.records.filter(r => {
      const p = ledger.get(r.requestId);
      return !p || (!p.duplicateOf && p.manualDecision !== 'ignore' && !p.rejected && p.countState !== 'excluded');
    });
    pruneOldData(merged); return merged;
  }
  function installStorageSync() {
    if (typeof GM_addValueChangeListener !== 'function') return;
    GM_addValueChangeListener(STORAGE_KEY, (_key, _old, next, remote) => {
      if (!remote || !isActiveUiOwner()) return;
      const incoming = parseStored(next); if (!incoming || typeof incoming !== 'object') return;
      const merged = mergeState(savedBaseline, state, incoming);
      savedBaseline = cloneState({ ...incoming, pending: incoming.pending || [], settings: normalizeSettings(incoming.settings || {}) });
      state = merged; render();
    });
  }
  function saveStateSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveStateNow, 120); }
  function saveStateNow() {
    if (!isActiveUiOwner()) return;
    const write = () => {
      if (!isActiveUiOwner()) return;
      pruneOldData();
      try {
        const remote = parseStored(GM_getValue(STORAGE_KEY, null));
        const next = remote && typeof remote === 'object' ? mergeState(savedBaseline, state, remote) : cloneState(state);
        GM_setValue(STORAGE_KEY, next); state = next; savedBaseline = cloneState(next);
      } catch (error) { console.error(`[${APP_ID}] 保存失败`, error); }
    };
    // Same-origin tabs serialize read/merge/write instead of overwriting an
    // entire stale state. No extra network traffic or provider permissions.
    if (navigator.locks?.request) return navigator.locks.request(`${APP_ID}:storage`, write).catch(() => write());
    write();
  }

  function getPageWindow() {
    return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  }

  function claimUiOwnership() {
    try {
      getPageWindow()[UI_OWNER_KEY] = channel;
    } catch (_) {
      // The page window should normally be writable; UI still works without it.
    }
  }

  function isActiveUiOwner() {
    try {
      return getPageWindow()[UI_OWNER_KEY] === channel;
    } catch (_) {
      return true;
    }
  }

  function installNetworkHook() {
    const page = getPageWindow();
    const attach = (takeOwnership = false) => {
      if (!isActiveUiOwner()) return;
      try { pageHookInstaller(page, channel, takeOwnership); }
      catch (error) { console.warn(`[${APP_ID}] 监听安装失败`, error); }
    };
    attach(true);
    // No navigation handler clears the pending request ledger.
    const repair = () => { attach(false); ensureUiAttached(); };
    setInterval(repair, 1500);
    for (const name of ['focus', 'pageshow', 'popstate', 'hashchange', 'urlchange']) {
      window.addEventListener(name, repair, { passive: true });
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) repair(); });
    // Repair before the site's click/submit/key handlers, not after a 3s timer.
    document.addEventListener('pointerdown', () => attach(false), true);
    document.addEventListener('submit', () => attach(false), true);
    document.addEventListener('keydown', (event) => { if (event.key === 'Enter') attach(false); }, true);
    window.addEventListener('pagehide', () => { saveStateNow(); });
  }

  function pageHookInstaller(page, eventChannel, takeOwnership = true) {
    if (!page || typeof page.fetch !== 'function') return;
    const existing = page[HOOK_STATE_KEY];
    if (existing && existing.version === '2.6' && typeof existing.repair === 'function') {
      if (takeOwnership) existing.channel = eventChannel;
      existing.repair();
      if (takeOwnership) existing.announce();
      return;
    }
    const hookState = {
      version: '2.6', channel: eventChannel, installedAt: Date.now(),
      depth: 0, wrappedFetch: null, fetchGetter: null, repaired: 0,
    };
    page[HOOK_STATE_KEY] = hookState;
    page.__CHATGPT_PRO_USAGE_ESTIMATOR_HOOK__ = hookState;
    function safePost(payload) {
      try {
        const current = page[HOOK_STATE_KEY];
        page.postMessage({ source: HOOK_EVENT_SOURCE, channel: current?.channel || eventChannel, payload }, page.location.origin);
      } catch (_) { /* Observation must never interfere with the site. */ }
    }
    function randomId() {
      return page.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    }
    function snapshot() {
      return { href: page.location.href, pathname: page.location.pathname, search: page.location.search, startedAt: Date.now() };
    }
    function postMeta(type, meta, extra = {}) { safePost({ type, ...meta, ...extra }); }
    function getRequestUrl(input) {
      try { return typeof input === 'string' ? input : (input?.url || String(input || '')); } catch (_) { return ''; }
    }
    function getRequestMethod(input, init) { return String(init?.method || input?.method || 'GET').toUpperCase(); }
    function readRequestBody(input, init) {
      try {
        const body = init?.body;
        if (typeof body === 'string') return Promise.resolve(body);
        if (body instanceof page.Blob) return body.text().catch(() => '');
        if (body instanceof page.ArrayBuffer || page.ArrayBuffer.isView(body)) return Promise.resolve(new page.TextDecoder().decode(body));
        if (body instanceof page.URLSearchParams) return Promise.resolve(body.toString());
        if (body instanceof page.FormData) {
          for (const k of ['payload', 'data', 'body', 'request']) { const v = body.get(k); if (typeof v === 'string') return Promise.resolve(v); }
        }
        if (input && typeof input.clone === 'function') return input.clone().text().catch(() => '');
      } catch (_) { /* Log the unreadable request, but do not consume its body. */ }
      return Promise.resolve('');
    }
    function parseJson(text) { try { return JSON.parse(text); } catch (_) { return null; } }
    function endpoint(rawUrl, snap = snapshot()) {
      try {
        const u = new page.URL(rawUrl, snap.href);
        if (u.origin !== page.location.origin) return null;
        if (/\/(codex|work|tasks?|scheduled|voice)(\/|$)/i.test(u.pathname)) return null;
        return u;
      } catch (_) { return null; }
    }
    function isTelemetryEndpoint(rawUrl, snap) {
      const u = endpoint(rawUrl, snap);
      return u?.pathname === '/ces/v1/telemetry/intake';
    }
    function observeTelemetry(input, init, snap, transport) {
      // Only a small JSON copy of this exact same-origin endpoint is inspected.
      const b = init?.body;
      if ((typeof b === 'string' && b.length > 1024 * 1024) || Number(b?.size || b?.byteLength || 0) > 1024 * 1024) return;
      readRequestBody(input, init).then(text => {
        if (!text || text.length > 1024 * 1024) return;
        const obj = parseJson(text); if (!obj || typeof obj !== 'object') return;
        const hints = []; let budget = 3000;
        const skip = /^(content|text|parts|messages|prompt|input|attachments|reasoning|thinking|arguments|tool_calls)$/i;
        const slugAt = node => {
          if (!node || typeof node !== 'object') return '';
          const direct = node.type === 'server_ste_metadata' ? node.metadata?.model_slug : '';
          const nested = node.server_ste_metadata;
          return direct || nested?.model_slug || nested?.metadata?.model_slug || '';
        };
        function localSlugs(node, depth = 0) {
          if (!node || typeof node !== 'object' || depth > 6) return [];
          const own = slugAt(node);
          const result = typeof own === 'string' && own.trim() && own.length < 180 ? [own] : [];
          const t = node.turn_analytics;
          if (Array.isArray(t)) for (const v of t.slice(0, 50)) result.push(...localSlugs(v, depth + 1));
          else if (t && typeof t === 'object') result.push(...localSlugs(t, depth + 1));
          return result;
        }
        function walk(node, depth = 0) {
          if (!node || typeof node !== 'object' || depth > 12 || --budget < 0 || hints.length >= 100) return;
          const ids = ['message_id', 'user_message_id', 'current_message_id']
            .map(k => Object.prototype.hasOwnProperty.call(node, k) && node[k])
            .filter(v => typeof v === 'string' && v.length < 180);
          const slugs = [...new Set(localSlugs(node))];
          if (ids.length && slugs.length === 1) {
            for (const id of new Set(ids)) hints.push({ messageId: id,
              conversationId: typeof node.conversation_id === 'string' ? node.conversation_id.slice(0,180) : '',
              actualModel: slugs[0], actualModelPath: 'telemetry.server_ste_metadata.model_slug' });
          }
          for (const [k, v] of Object.entries(node)) {
            if (!skip.test(k) && v && typeof v === 'object') walk(v, depth + 1);
          }
        }
        walk(obj);
        if (hints.length) safePost({type: 'model-hints', hints, transport,
          requestUrlPath: '/ces/v1/telemetry/intake', startedAt: snap.startedAt});
      }).catch(() => {});
    }
    function isPotentialGenerationEndpoint(rawUrl, snap) {
      const u = endpoint(rawUrl, snap);
      return !!u && /^\/(?:backend-api|api|v1)\//i.test(u.pathname)
        && /(conversation|responses?|completion|generate|message|turn|chat)/i.test(u.pathname)
        && !/(?:^|\/)(?:analytics|telemetry|feedback|moderation|upload|files?|attachments?|search|share|title)(?:\/|$)/i.test(u.pathname);
    }
    function snapshotEndpoint(rawUrl, snap) {
      const u = endpoint(rawUrl, snap);
      const match = u?.pathname.match(/^\/backend-api\/(?:f\/)?conversation\/([^/]+)\/?$/i);
      return match && !/^(prepare|stream|init|finalize|resume)$/i.test(match[1]) ? match[1] : '';
    }
    function isExcludedPageRoute(pathname, search) {
      return /^\/(codex|work|tasks?|scheduled-tasks?|voice)(\/|$)/i.test(pathname || '')
        || /^\/g\/g-(?!p-)/i.test(pathname || '')
        || /(?:^|[?&])(mode|surface|product)=(codex|work|task|scheduled|voice)(?:&|$)/i.test(search || '');
    }
    function getByPath(object, path) {
      let c = object;
      for (const k of path) { if (!c || typeof c !== 'object') return undefined; c = c[k]; }
      return c;
    }
    function extractRequestedModel(body) {
      for (const p of [['model'], ['model_slug'], ['model_name'], ['conversation_mode', 'model'], ['metadata', 'model'], ['metadata', 'model_slug']]) {
        const v = getByPath(body, p); if (typeof v === 'string' && v.length < 180) return v;
      }
      return '';
    }
    function isExcludedBodyMode(body) {
      const gizmo = body.gizmo_id || body.gizmoId || body.metadata?.gizmo_id;
      if (typeof gizmo === 'string' && gizmo && !/^g-p-/i.test(gizmo)) return true;
      let excluded = false;
      function walk(node, depth) {
        if (!node || typeof node !== 'object' || depth > 5) return;
        for (const [k, v] of Object.entries(node)) {
          if (/^(messages|content|text|prompt|input|attachments|parts)$/i.test(k)) continue;
          if (typeof v === 'string' && /(mode|surface|product|experience|feature|context_type)/i.test(k)
            && /^(codex|work|deep[-_ ]?research|research[-_ ]?mode|agent[-_ ]?mode|scheduled|task[-_ ]?mode|voice(?:[-_ ]?mode)?)$/i.test(v)) excluded = true;
          else if (v && typeof v === 'object') walk(v, depth + 1);
        }
      }
      walk(body, 0); return excluded;
    }
    function buildRequestMeta(rawUrl, method, body, snap, transport) {
      if (method !== 'POST' || !isPotentialGenerationEndpoint(rawUrl, snap) || !body || typeof body !== 'object') return null;
      if (isExcludedPageRoute(snap.pathname, snap.search) || isExcludedBodyMode(body)) return null;
      const u = endpoint(rawUrl, snap);
      // Preparation, title, feedback, etc. are not generation attempts.
      if (/\/(prepare|init|check|finalize|title|feedback)(?:\/|$)/i.test(u.pathname)) return null;
      if (!(Array.isArray(body.messages) || /^(next|continue|variant|retry|regenerate|submit|create)$/i.test(body.action || '') || body.input)) return null;
      const msg = Array.isArray(body.messages) ? [...body.messages].reverse().find(m => (m?.author?.role || m?.role) === 'user') : ((body.message?.author?.role || body.message?.role) === 'user' ? body.message : null);
      const routeId = snap.pathname.match(/\/c\/([^/?]+)/i)?.[1] || '';
      return {
        action: String(body.action || 'next'), thinkingEffort: String(body.thinking_effort || body.reasoning_effort || body.reasoning?.effort || ''),
        requestId: randomId(), clientRequestId: String(body.client_request_id || body.request_id || ''),
        userMessageId: String(msg?.id || msg?.message_id || ''), parentMessageId: String(body.parent_message_id || ''),
        conversationId: String(body.conversation_id || body.conversationId || body.metadata?.conversation_id || routeId),
        requestedModel: extractRequestedModel(body), route: `${snap.pathname}${snap.search}`,
        requestUrlPath: u.pathname, startedAt: snap.startedAt, transport,
      };
    }
    function slimMessage(message) {
      if (!message || typeof message !== 'object') return null;
      const role = message.author?.role || message.role;
      if (role !== 'assistant') return null;
      const meta = message.metadata || {};
      const result = {
        id: String(message.id || message.message_id || ''), author: { role: 'assistant' },
        status: String(message.status || ''), channel: String(message.channel || meta.channel || ''),
        end_turn: message.end_turn === true, recipient: String(message.recipient || ''),
        create_time: Number(message.create_time || message.created_at || 0), metadata: {},
      };
      for (const k of ['actual_model_slug','resolved_model_slug','actual_model','resolved_model','used_model','model_slug','model_name','model_id','model','thinking_effort','reasoning_effort']) {
        if (typeof meta[k] === 'string') result.metadata[k] = meta[k].slice(0, 180);
        if (typeof message[k] === 'string') result[k] = message[k].slice(0, 180);
      }
      const reported = meta.server_ste_metadata?.model_slug || meta.server_ste_metadata?.metadata?.model_slug
        || message.server_ste_metadata?.model_slug || message.server_ste_metadata?.metadata?.model_slug;
      if (typeof reported === 'string') result.metadata.server_reported_model = reported.slice(0,180);
      return result;
    }
    function inspectSnapshot(object, conversationId) {
      if (!object || !object.mapping || typeof object.mapping !== 'object') return;
      const nodes = [];
      // Only metadata and tree edges leave the network inspector. Never content.
      for (const [key, value] of Object.entries(object.mapping).slice(-10000)) {
        const m = value?.message;
        const role = m?.author?.role || m?.role || '';
        nodes.push({ nodeId: String(key), parent: String(value?.parent || ''),
          messageId: String(m?.id || ''), role: String(role), message: slimMessage(m) });
      }
      safePost({ type: 'conversation-snapshot', conversationId: String(object.conversation_id || conversationId || ''), nodes });
    }

    function createResponseInspector(meta, httpOk = true, httpStatus = 200) {
      const r = { assistantSeen: false, assistantId: '', conversationId: meta.conversationId,
        actualModel: '', actualModelPath: '', actualThinkingEffort: '', score: 0, complete: false, fatal: false,
        message: null, sequence: 0, notified: '', finalized: false };
      const skip = /^(content|text|parts|prompt|input|attachments|reasoning|thinking|arguments|tool_calls|output_text)$/i;
      const successStatus = /^(finished_successfully|completed|complete|done|success)$/i;
      const failureStatus = /^(failed|error|cancelled|canceled|aborted)$/i;
      function candidate(key, value, path, insideAssistant) {
        if (typeof value !== 'string' || value.length > 180 || !/(gpt|astra|sol|luna|terra)/i.test(value)) return;
        if (/(requested|selected|default|fallback)/i.test(key + ' ' + path)) return;
        let score = /^(actual|resolved|real|used|executed|backend|serving)_?model(?:_slug)?$/i.test(key) ? 300
          : /(?:^|\.)server_ste_metadata(?:\.|$)/.test(path) && key === 'model_slug' ? 290
          : /^(model_slug|model_name|model_id)$/i.test(key) ? 115 : key === 'model' ? 95 : 0;
        if (!score) return;
        if (insideAssistant && score < 200) score += 45;
        if (score >= r.score) { r.score = score; r.actualModel = value; r.actualModelPath = path; }
      }
      function mergeMessage(node) {
        const id = node.id || node.message_id;
        if (id && id !== r.assistantId) {
          r.message = {};
          // An analysis message and final answer may have different IDs. The
          // route evidence belongs to the request; do not erase it on that transition.
          if (r.assistantId) { r.complete = false; }
        }
        const clean = {};
        for (const k of ['id','message_id','role','author','status','state','channel','recipient','end_turn']) if (node[k] !== undefined) clean[k] = node[k];
        clean.metadata = {};
        for (const k of ['channel','model','model_slug','model_name','model_id','actual_model_slug','resolved_model_slug','actual_model','resolved_model','used_model']) if (node.metadata?.[k] !== undefined) clean.metadata[k] = node.metadata[k];
        r.message = { ...(r.message || {}), ...clean, metadata: { ...(r.message?.metadata || {}), ...clean.metadata } };
        const m = r.message;
        if (id) r.assistantId = String(id);
        r.assistantSeen = true;
        const status = String(m.status || m.state || '');
        if (/^(failed|error)$/i.test(status)) r.fatal = true; // User stop/abort is NOT a refund proof.
        const finalChannel = (m.channel || m.metadata?.channel || '').toLowerCase();
        const recipient = String(m.recipient || 'all');
        if (successStatus.test(status) && recipient === 'all' && finalChannel !== 'analysis'
          && finalChannel !== 'commentary' && m.end_turn !== false) r.complete = true;
        if (m.end_turn === true && !failureStatus.test(status) && (finalChannel === 'final' || !finalChannel)) r.complete = true;
      }
      function applyPatch(node) {
        const p = node.p ?? node.path;
        if (typeof p !== 'string') return false;
        const v = node.v !== undefined ? node.v : node.value;
        if (!p || p === '/') { if (v && typeof v === 'object') walk(v, '', false, 0); return true; }
        if (/^\/message\/(?:content|text|parts|thinking|reasoning)(?:\/|$)/i.test(p)) return true;
        if (p === '/message' && v && typeof v === 'object') { walk({ message: v }, '', false, 0); return true; }
        if (p.startsWith('/message/')) {
          const keys = p.slice(9).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
          if (keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) return true;
          if (!/^(id|author|role|status|state|end_turn|channel|recipient|metadata|model|model_slug|model_name|model_id|resolved_model_slug|actual_model_slug)$/.test(keys[0])) return true;
          const partial = {};
          let cursor = partial;
          for (const key of keys.slice(0, -1)) cursor = cursor[key] = {};
          cursor[keys[keys.length - 1]] = v;
          if (r.assistantSeen || partial.author?.role === 'assistant' || partial.role === 'assistant') {
            mergeMessage(partial); walk(partial, 'message', true, 0);
          }
          return true;
        }
        if (/^\/(conversation_id|conversationId)$/.test(p) && typeof v === 'string') r.conversationId = v;
        return true;
      }
      function walk(node, path, inheritedAssistant, depth) {
        if (!node || typeof node !== 'object' || depth > 12) return;
        if (Array.isArray(node)) { for (const v of node) walk(v, path, inheritedAssistant, depth + 1); return; }
        if (('p' in node || 'path' in node) && ('v' in node || 'value' in node) && applyPatch(node)) return;
        const role = node.author?.role || node.role || '';
        if (role && !['assistant', 'system'].includes(role)) return;
        const insideAssistant = inheritedAssistant || role === 'assistant';
        if (role === 'assistant') mergeMessage(node);
        if (typeof node.conversation_id === 'string') r.conversationId = node.conversation_id;
        const type = String(node.type || node.event || '');
        if (type === 'server_ste_metadata') path = 'server_ste_metadata';
        if (/^(response|turn|conversation)\.completed$/.test(type)) r.complete = true;
        if (/^(response|turn|message)\.(failed|error)$/.test(type) || type === 'error') r.fatal = true;
        if (node.error && !insideAssistant) r.fatal = true;
        for (const [k, v] of Object.entries(node)) {
          if (skip.test(k) || /^(request|requested|selected|default|fallback|mapping|history)$/i.test(k)) continue;
          if (typeof v === 'string') {
            if (/^(thinking_effort|reasoning_effort)$/.test(k)) r.actualThinkingEffort = v.slice(0,80);
            if (k === 'effort' && /(?:^|\.)reasoning$/.test(path)) r.actualThinkingEffort = v.slice(0,80);
            candidate(k, v, `${path}.${k}`, insideAssistant || (path === 'message' && r.assistantSeen));
          }
          else if (v && typeof v === 'object') walk(v, path ? `${path}.${k}` : k, insideAssistant, depth + 1);
        }
      }
      function payload() { return {
        assistantId: r.assistantId, conversationId: r.conversationId,
        actualModel: r.actualModel, actualModelPath: r.actualModelPath, actualThinkingEffort: r.actualThinkingEffort,
        assistantSeen: r.assistantSeen,
        confidence: r.score >= 135 ? 'actual' : r.score >= 90 ? 'response' : 'none',
      }; }
      function finish(reason = '') {
        if (r.finalized) return;
        r.finalized = true;
        const success = Boolean(httpOk && !r.fatal && r.assistantSeen && r.complete);
        postMeta('generation-finished', meta, { ...payload(), success, finishedAt: Date.now(),
          reason: !httpOk ? `http-${httpStatus}` : r.fatal ? 'response-failed' : success ? 'ok' : (reason || 'completion-unconfirmed') });
      }
      function inspectObject(object) {
        if (r.finalized) return;
        try { walk(object, '', false, 0); } catch (_) { /* Future/malformed schema: remain unconfirmed. */ }
        const key = `${r.assistantId}:${r.actualModel}:${r.actualModelPath}:${r.actualThinkingEffort}:${r.conversationId}`;
        if (key !== r.notified && (r.assistantSeen || r.actualModel)) {
          r.notified = key;
          postMeta('generation-progress', meta, { ...payload(), stage: 'assistant-observed' });
        }
        // Accounting already happens on progress. Keep reading after final-message
        // metadata so a later resolved-model event can still correct the entry.
        if (r.fatal) finish();
      }
      function inspectData(text, eventName = '') {
        const t = String(text || '').trim();
        if (!t || r.finalized) return;
        if (t === '[DONE]') { r.complete = true; if (r.assistantSeen) finish(); return; }
        const candidateText = t.replace(/^\d+:(?=[{\[])/, '');
        const obj = parseJson(candidateText);
        if (obj && typeof obj === 'object') {
          if (eventName && !obj.type) obj.type = eventName;
          inspectObject(obj);
        }
        // Deliberately no regex over reply text. Quoted JSON is not metadata.
      }
      return { inspectObject, inspectData, finish, get finalized() { return r.finalized; } };
    }

    function createLineParser(inspector) {
      let buffer = '', data = [], dataSize = 0, eventName = '';
      const MAX_EVENT = 2 * 1024 * 1024;
      function flush() { if (data.length) inspector.inspectData(data.join('\n'), eventName); data = []; dataSize = 0; eventName = ''; }
      function line(value) {
        if (!value) { flush(); return; }
        if (value.startsWith('data:')) {
          dataSize += value.length;
          if (dataSize > MAX_EVENT) { inspector.finish('metadata-event-too-large'); data = []; return; }
          data.push(value.slice(5).replace(/^ /, '')); return;
        }
        if (value.startsWith('event:')) { eventName = value.slice(6).trim(); return; }
        if (/^(id:|retry:|:)/.test(value)) return;
        flush(); inspector.inspectData(value);
      }
      return {
        push(text) {
          buffer += text;
          let i;
          while ((i = buffer.indexOf('\n')) >= 0) { const s = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1); line(s); }
          if (buffer.length > 2 * 1024 * 1024) { buffer = ''; data = []; } // Bounded diagnostic copy.
        },
        end() { if (buffer) line(buffer.replace(/\r$/, '')); buffer = ''; flush(); },
      };
    }
    async function inspectResponse(response, meta) {
      const inspector = createResponseInspector(meta, response.ok, response.status);
      postMeta('generation-progress', meta, { stage: 'response-headers', httpStatus: response.status });
      let reader;
      try {
        if (!response.ok) { inspector.finish(); response.body?.cancel().catch(() => {}); return; }
        const type = response.headers.get('content-type') || '';
        if (type.includes('application/json') && !type.includes('ndjson')) {
          inspector.inspectObject(await response.json()); inspector.finish(); return;
        }
        const parser = createLineParser(inspector);
        if (response.body?.getReader) {
          reader = response.body.getReader();
          const decoder = new page.TextDecoder();
          while (!inspector.finalized) {
            const { done, value } = await reader.read(); if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
          parser.push(decoder.decode()); parser.end();
        } else { parser.push(await response.text()); parser.end(); }
        inspector.finish();
      } catch (_) { inspector.finish('transport-ended-unconfirmed'); }
      finally {
        // Cancel only our cloned branch; never the application's request/signal.
        if (reader) { try { reader.cancel().catch(() => {}); reader.releaseLock(); } catch (_) {} }
      }
    }
    function makeFetchWrapper(originalFetch) {
      function wrappedFetch(input, init) {
        if (page[HOOK_STATE_KEY] !== hookState || hookState.depth) return Reflect.apply(originalFetch, this, arguments);
        const rawUrl = getRequestUrl(input), method = getRequestMethod(input, init), snap = snapshot();
        const preAbortedAtDispatch = (init?.signal || input?.signal)?.aborted === true;
        const watch = method === 'POST' && isPotentialGenerationEndpoint(rawUrl, snap);
        if (method === 'POST' && isTelemetryEndpoint(rawUrl, snap)) observeTelemetry(input, init, snap, 'fetch');
        const snapshotId = method === 'GET' && state.pending?.length ? snapshotEndpoint(rawUrl, snap) : '';
        const metaPromise = watch ? readRequestBody(input, init).then(text => {
          const body = parseJson(text);
          const meta = buildRequestMeta(rawUrl, method, body, snap, 'fetch');
          if (meta) {
            meta.preAborted = preAbortedAtDispatch;
            postMeta('generation-started', meta);
          }
          else if (!body && !isExcludedPageRoute(snap.pathname, snap.search)) {
            safePost({ type: 'hook-diagnostic', reason: 'request-body-unreadable', route: snap.pathname, requestUrlPath: endpoint(rawUrl, snap)?.pathname || '', startedAt: snap.startedAt });
          }
          return meta;
        }).catch(() => null) : Promise.resolve(null);
        let promise;
        try { hookState.depth++; promise = Reflect.apply(originalFetch, this, arguments); }
        catch (error) {
          metaPromise.then(meta => { if (meta) postMeta('generation-finished', meta, { success: false, reason: meta.preAborted ? 'not-dispatched-aborted' : 'transport-ended-unconfirmed', finishedAt: Date.now() }); });
          throw error;
        } finally { hookState.depth--; }
        if (!watch && !snapshotId) return promise;
        return Promise.resolve(promise).then(response => {
          let clone = null; try { clone = response.clone(); } catch (_) {}
          if (snapshotId) {
            if (clone?.ok && /json/i.test(clone.headers.get('content-type') || '')) clone.json().then(o => inspectSnapshot(o, snapshotId)).catch(() => {});
            else clone?.body?.cancel().catch(() => {});
          } else {
            metaPromise.then(meta => {
              if (!meta) { clone?.body?.cancel().catch(() => {}); return; }
              if (clone) inspectResponse(clone, meta);
              else postMeta('generation-finished', meta, { success: false, reason: 'response-clone-failed', finishedAt: Date.now() });
            }).catch(() => {});
          }
          return response;
        }, error => {
          metaPromise.then(meta => { if (meta) postMeta('generation-finished', meta, { success: false, reason: meta.preAborted ? 'not-dispatched-aborted' : 'transport-ended-unconfirmed', finishedAt: Date.now() }); });
          throw error;
        });
      }
      try { Object.defineProperty(wrappedFetch, 'name', { value: 'fetch' }); } catch (_) {}
      return wrappedFetch;
    }
    function installFetch() {
      const descriptor = Object.getOwnPropertyDescriptor(page, 'fetch');
      if (page.fetch === hookState.wrappedFetch && (descriptor?.get === hookState.fetchGetter || descriptor?.configurable === false)) return;
      const delegate = !hookState.wrappedFetch && existing?.wrappedFetch === page.fetch && existing?.originalFetch ? existing.originalFetch : page.fetch;
      if (typeof delegate !== 'function') return;
      hookState.wrappedFetch = makeFetchWrapper(delegate);
      if (!descriptor || descriptor.configurable) {
        hookState.fetchGetter = () => hookState.wrappedFetch;
        Object.defineProperty(page, 'fetch', {
          configurable: true, enumerable: descriptor?.enumerable ?? true,
          get: hookState.fetchGetter,
          set(next) {
            if (typeof next !== 'function' || next === hookState.wrappedFetch) return;
            hookState.wrappedFetch = makeFetchWrapper(next);
            hookState.repaired++;
            safePost({ type: 'hook-diagnostic', reason: 'fetch-rebound', startedAt: Date.now() });
          },
        });
      } else if (descriptor.writable) { page.fetch = hookState.wrappedFetch; }
    }
    let xhrState = null;
    function installXHR() {
      const proto = page.XMLHttpRequest?.prototype;
      if (!proto || (xhrState && proto.open === xhrState.open && proto.send === xhrState.send)) return;
      const open0 = proto.open, send0 = proto.send, entries = new WeakMap();
      function open(method, url) {
        const ret = Reflect.apply(open0, this, arguments);
        entries.set(this, { method: String(method).toUpperCase(), url: String(url) }); return ret;
      }
      function send(body) {
        if (page[HOOK_STATE_KEY] !== hookState) return Reflect.apply(send0, this, arguments);
        const info = entries.get(this), xhr = this;
        if (!info) return Reflect.apply(send0, this, arguments);
        const snap = snapshot(), snapId = info.method === 'GET' && state.pending?.length ? snapshotEndpoint(info.url, snap) : '';
        if (info.method === 'POST' && isTelemetryEndpoint(info.url, snap)) observeTelemetry(info.url, {body}, snap, 'xhr');
        const meta = typeof body === 'string' ? buildRequestMeta(info.url, info.method, parseJson(body), snap, 'xhr') : null;
        if (!meta && !snapId) return Reflect.apply(send0, this, arguments);
        if (meta) postMeta('generation-started', meta);
        let inspector = null, parser = null, offset = 0;
        const progress = () => {
          if (!meta || xhr.readyState < 2) return;
          if (!inspector) {
            inspector = createResponseInspector(meta, xhr.status >= 200 && xhr.status < 300, xhr.status);
            parser = createLineParser(inspector);
            postMeta('generation-progress', meta, { stage: 'response-headers', httpStatus: xhr.status });
          }
          if ((!xhr.responseType || xhr.responseType === 'text') && !/application\/json/i.test(xhr.getResponseHeader('content-type') || '')) {
            try { const text = xhr.responseText; parser.push(text.slice(offset)); offset = text.length; } catch (_) {}
          }
        };
        const end = () => {
          try {
            progress();
            if (snapId && xhr.status >= 200 && xhr.status < 300) {
              const obj = xhr.responseType === 'json' ? xhr.response : parseJson(xhr.responseText); inspectSnapshot(obj, snapId);
            }
            if (meta && inspector) {
              if (xhr.responseType === 'json') inspector.inspectObject(xhr.response);
              else if (/application\/json/i.test(xhr.getResponseHeader('content-type') || '')) inspector.inspectObject(parseJson(xhr.responseText));
              else parser.end();
              inspector.finish(xhr.status === 0 ? 'transport-ended-unconfirmed' : 'completion-unconfirmed');
            } else if (meta) postMeta('generation-finished', meta, { success: false, reason: 'transport-ended-unconfirmed', finishedAt: Date.now() });
          } catch (_) { if (meta && inspector) inspector.finish('transport-ended-unconfirmed'); }
          xhr.removeEventListener('progress', progress); xhr.removeEventListener('loadend', end);
        };
        xhr.addEventListener('progress', progress); xhr.addEventListener('loadend', end);
        try { return Reflect.apply(send0, this, arguments); }
        catch (e) { end(); throw e; }
      }
      proto.open = open; proto.send = send; xhrState = { open, send };
    }
    let beaconWrapper = null;
    function installBeacon() {
      const owner = page.navigator;
      if (!owner || typeof owner.sendBeacon !== 'function' || owner.sendBeacon === beaconWrapper) return;
      const delegate = owner.sendBeacon;
      beaconWrapper = function (url, data) {
        if (page[HOOK_STATE_KEY] !== hookState) return Reflect.apply(delegate, this, arguments);
        const snap = snapshot();
        try { if (isTelemetryEndpoint(String(url), snap)) observeTelemetry(String(url), {body: data}, snap, 'beacon'); } catch (_) {}
        return Reflect.apply(delegate, this, arguments);
      };
      try { owner.sendBeacon = beaconWrapper; } catch (_) { /* Optional passive hint channel. */ }
    }
    hookState.repair = () => { if (page[HOOK_STATE_KEY] !== hookState) return; installFetch(); installXHR(); installBeacon(); };
    hookState.announce = () => safePost({ type: 'hook-ready', hookVersion: '2.6', fetchAttached: page.fetch === hookState.wrappedFetch, installedAt: hookState.installedAt });
    hookState.repair();
    for (const name of ['pushState', 'replaceState']) {
      const original = page.history?.[name];
      if (typeof original !== 'function') continue;
      page.history[name] = function () {
        const ret = Reflect.apply(original, this, arguments);
        hookState.repair();
        safePost({ type: 'route-changed', route: page.location.pathname, startedAt: Date.now() });
        return ret;
      };
    }
    hookState.announce();
  }

  function listenForHookEvents() {
    window.addEventListener('message', event => {
      if (event.source !== getPageWindow() || event.origin !== location.origin || !isActiveUiOwner()) return;
      const data = event.data;
      if (!data || data.source !== HOOK_EVENT_SOURCE || data.channel !== channel) return;
      handleGenerationEvent(data.payload);
    });
  }

  function classifyModel(rawValue, effortValue = '') {
    const value = String(rawValue || '').trim().toLowerCase()
      .replace(/[‐‑‒–—−]/g, '-').replace(/_/g, '-').replace(/\s+/g, '-');
    const effort = String(effortValue || '').trim().toLowerCase();
    if (!value) return {model: null, explicitNonPro: false, reason: 'empty'};
    const token = word => new RegExp(`(?:^|-)${word}(?:-|$)`).test(value);
    const hasPro = token('pro');
    const nonEffort = /^(instant|none|low|medium|high|extra[-_ ]?high|xhigh)$/.test(effort);
    const knownNon = /(?:^|-)(mini|nano|luna|terra|instant|medium|high|xhigh)(?:-|$)/.test(value);
    const g6 = /(?:^|-)gpt-?6(?:[.-]|$)/.test(value) || token('astra');
    const g56 = /(?:^|-)gpt-?5[.-]?6(?:-|$)/.test(value);
    const sol = token('sol');
    if (g6) {
      if (knownNon || (token('thinking') && !hasPro && effort !== 'pro'))
        return {model:null, explicitNonPro:true, reason:'gpt6-non-pro-variant'};
      return {model:'gpt6', explicitNonPro:false, reason:'gpt6-or-astra'};
    }
    if (g56 || sol) {
      if (knownNon || (!hasPro && nonEffort) || (token('thinking') && !hasPro && effort !== 'pro'))
        return {model:null, explicitNonPro:true, reason:'gpt56-explicit-non-pro'};
      if (hasPro || effort === 'pro') return {model:'solpro', explicitNonPro:false, reason:hasPro?'sol-pro':'sol-with-pro-effort'};
      // Sol also powers non-Pro thinking levels; the name alone cannot decide.
      return {model:null, explicitNonPro:false, reason:'sol-tier-unspecified'};
    }
    if (/^(?:gpt-|o[134](?:-|$)|claude|gemini)/.test(value))
      return {model:null, explicitNonPro:true, reason:'other-model'};
    return {model:null, explicitNonPro:false, reason:'unrecognized'};
  }

  // An identifier is evidence of the reported route, never a measurement of intelligence.
  function evidenceRank(path) {
    if (/(?:resolved|actual)_model(?:_slug)?$/.test(path || '')) return 300;
    if ((path || '').includes('server_ste_metadata')) return 290;
    return path ? 100 : 0;
  }
  function preserveStrongerModel(previous, next) {
    if (previous.actualModel && (!next.actualModel || evidenceRank(previous.actualModelPath) > evidenceRank(next.actualModelPath)
      || (previous.actualModel === next.actualModel && previous.actualModelPath === next.actualModelPath && !['actual','response'].includes(next.confidence)))) {
      for (const key of ['actualModel','actualModelPath','actualThinkingEffort','confidence']) next[key] = previous[key];
    }
  }
  function handleModelHints(payload) {
    if (!Array.isArray(payload.hints)) return;
    const groups = new Map();
    for (const hint of payload.hints.slice(0, 100)) {
      if (!hint || typeof hint.messageId !== 'string' || typeof hint.actualModel !== 'string') continue;
      const list = groups.get(hint.messageId) || []; list.push(hint); groups.set(hint.messageId, list);
    }
    for (const [messageId, hints] of groups) {
      if (new Set(hints.map(h => h.actualModel)).size !== 1) continue;
      const hint = hints[0];
      // Include completed/confirmed attempts in ambiguity checks: a late hint
      // for regeneration sharing a user ID must not attach to the wrong run.
      const matches = state.pending.filter(p => !p.duplicateOf && p.userMessageId === messageId
        && (!hint.conversationId || !p.conversationId || p.conversationId === hint.conversationId));
      if (matches.length !== 1 || matches[0].manualDecision || matches[0].rejected) continue;
      const previous = matches[0];
      const next = { ...previous, actualModel: hint.actualModel,
        actualModelPath: hint.actualModelPath || 'telemetry.server_ste_metadata.model_slug', confidence: 'actual' };
      preserveStrongerModel(previous, next);
      if (next.actualModel === previous.actualModel && next.actualModelPath === previous.actualModelPath) continue;
      const p = upsertPending(next, previous.stage);
      eventLog(p, 'model-hint', 'matched-user-message-id');
      syncAccounting(p, 'matched-model-hint'); // Never requires generation completion.
    }
    saveStateNow(); render();
  }

  function normalizePending(raw) {
    if (!raw || typeof raw !== 'object' || !raw.requestId || !Number.isFinite(Number(raw.startedAt))) return null;
    const text = key => String(raw[key] || '').slice(0, 240);
    return {
      id: String(raw.requestId), requestId: String(raw.requestId), startedAt: Number(raw.startedAt),
      updatedAt: Number(raw.updatedAt) || Number(raw.startedAt), owner: text('owner'),
      clientRequestId: text('clientRequestId'), action: text('action') || 'next',
      userMessageId: text('userMessageId'), parentMessageId: text('parentMessageId'),
      conversationId: text('conversationId'), assistantId: text('assistantId'), requestedModel: text('requestedModel'),
      thinkingEffort: text('thinkingEffort'), actualThinkingEffort: text('actualThinkingEffort'),
      actualModel: text('actualModel'), actualModelPath: text('actualModelPath'), confidence: text('confidence'), route: text('route'),
      requestUrlPath: text('requestUrlPath'), transport: text('transport'), stage: text('stage') || 'awaiting',
      countingMode: raw.countingMode === 'request-first' ? 'request-first' : 'model-first',
      countState: text('countState') || 'unclassified', manualDecision: text('manualDecision'),
      duplicateOf: text('duplicateOf'), attemptKey: text('attemptKey'),
      accepted: Boolean(raw.accepted), assistantSeen: Boolean(raw.assistantSeen), rejected: Boolean(raw.rejected),
      responseComplete: Boolean(raw.responseComplete), httpStatus: Number(raw.httpStatus) || 0,
    };
  }

  function pendingById(id) { return state.pending.find(p => p.requestId === id); }
  function recordForRequest(id) { return id ? state.records.find(r => r.requestId === id) : null; }
  function unresolvedRequests() {
    return state.pending.filter(p => !p.manualDecision && !p.rejected && !p.duplicateOf
      && p.countState !== 'confirmed' && p.countState !== 'excluded' && p.countState !== 'legacy');
  }
  function upsertPending(payload, stage) {
    const old = pendingById(payload.requestId);
    const values = { ...(old || {}), ...payload, stage, owner: old?.owner || channel,
      updatedAt: Math.max(Date.now(), (old?.updatedAt || 0) + 1) };
    // Transport-only events may have missing/empty fields. Keep prior evidence.
    if (old) {
      for (const k of ['actualModel','actualModelPath','actualThinkingEffort','assistantId','conversationId','confidence']) {
        if (!values[k] && old[k]) values[k] = old[k];
      }
      preserveStrongerModel(old, values);
      values.accepted = old.accepted || values.accepted;
      values.assistantSeen = old.assistantSeen || values.assistantSeen;
      values.responseComplete = old.responseComplete || values.responseComplete;
    }
    const next = normalizePending(values);
    if (!next) return null;
    if (old) state.pending[state.pending.indexOf(old)] = next; else state.pending.push(next);
    saveStateSoon();
    return next;
  }
  function dropPending(id) {
    // Retained for compatibility with manual UI actions. Requests are tombstoned,
    // never forgotten just because the usage has already been counted.
    const p = pendingById(id); if (p) manualResolveRequest(p, 'ignore');
  }
  function eventLog(payload, result, reason, extra = {}) {
    addLog({ ts: Date.now(), result, reason, requestId: payload.requestId, conversationId: payload.conversationId,
      requestedModel: payload.requestedModel, actualModel: payload.actualModel, actualModelPath: payload.actualModelPath,
      confidence: payload.confidence, route: payload.route, requestUrlPath: payload.requestUrlPath, transport: payload.transport,
      eventKey: extra.eventKey || `request:${payload.requestId || ''}:${result}`, ...extra });
  }

  // A synchronous, per-request recovery journal avoids relying on a delayed
  // read/merge/write lock when a tab is closed just after sending. Each request
  // has its own key; concurrent tabs do not overwrite one another's journal.
  function journalPrefix() { return `${STORAGE_KEY}:request-journal:`; }
  function writeRequestJournal(p) {
    if (!p || typeof GM_setValue !== 'function') return;
    try { GM_setValue(`${journalPrefix()}${p.requestId}`, {
      request: p, record: recordForRequest(p.requestId), updatedAt: p.updatedAt,
    }); } catch (error) { console.warn(`[${APP_ID}] 请求恢复日志保存失败`, error); }
  }
  function recoverRequestJournals(target) {
    if (typeof GM_listValues !== 'function') return;
    try {
      const prefix = journalPrefix(), cutoff = Date.now() - RETENTION_MS;
      const keys = GM_listValues(); if (!Array.isArray(keys)) return;
      for (const key of keys.filter(k => k.startsWith(prefix)).slice(-20000)) {
        const j = parseStored(GM_getValue(key, null));
        const p = normalizePending(j?.request);
        if (!p || p.startedAt < cutoff) { if (typeof GM_deleteValue === 'function') GM_deleteValue(key); continue; }
        const old = target.pending.find(item => item.requestId === p.requestId);
        if (old && old.updatedAt >= p.updatedAt) continue;
        if (old) target.pending[target.pending.indexOf(old)] = p; else target.pending.push(p);
        target.records = target.records.filter(r => r.requestId !== p.requestId);
        const r = normalizeRecord(j.record);
        if (r && !p.duplicateOf && p.manualDecision !== 'ignore' && !p.rejected && p.countState !== 'excluded') target.records.push(r);
      }
    } catch (error) { console.warn(`[${APP_ID}] 恢复请求记录失败`, error); }
  }
  function clearRequestJournals() {
    if (typeof GM_listValues !== 'function' || typeof GM_deleteValue !== 'function') return;
    try { for (const key of GM_listValues()) if (key.startsWith(journalPrefix())) GM_deleteValue(key); } catch (_) {}
  }

  function syncAccounting(p, reason = '') {
    if (!p) return;
    const old = recordForRequest(p.requestId);
    const beforeModel = old?.model || null, beforeStatus = old?.status || null;
    let model = null, status = 'provisional', decision = 'unclassified';
    const actual = classifyModel(p.actualModel, p.actualThinkingEffort);
    const requested = classifyModel(p.requestedModel, p.thinkingEffort);
    const reliable = ['actual','response'].includes(p.confidence);
    if (p.duplicateOf || p.manualDecision === 'ignore') decision = 'excluded';
    else if (p.manualDecision === 'gpt6' || p.manualDecision === 'solpro') {
      model = p.manualDecision; status = 'manual'; decision = 'confirmed';
    } else if (p.rejected) decision = 'rejected';
    else if (reliable && actual.explicitNonPro) decision = 'excluded';
    else if (reliable && actual.model) {
      model = actual.model; status = 'confirmed'; decision = 'confirmed';
    } else if (old && ['confirmed','manual','legacy'].includes(old.status)) {
      // Later generic/empty metadata must not erase prior specific confirmation.
      model = old.model; status = old.status; decision = old.status === 'legacy' ? 'legacy' : 'confirmed';
    } else if (p.countingMode === 'request-first' && requested.model) {
      model = requested.model; status = 'provisional'; decision = 'provisional';
    } else if (requested.explicitNonPro && !p.actualModel) decision = 'excluded';

    // An assistant can be re-delivered on a resume/reconciliation path. Collapse
    // it into the previously captured request, without using userMessageId alone
    // (regenerate and edit resends may deliberately reuse that ID).
    if (model && p.assistantId && !p.manualDecision) {
      const duplicate = state.records.find(r => r.requestId !== p.requestId && r.assistantId === p.assistantId
        && (!r.conversationId || !p.conversationId || r.conversationId === p.conversationId));
      if (duplicate) { p.duplicateOf = duplicate.requestId || duplicate.id; model = null; decision = 'excluded'; }
    }
    if (model) {
      const record = normalizeRecord({
        id: old?.id || `request:${p.requestId}`, eventKey: old?.eventKey || `request:${p.requestId}`,
        requestId: p.requestId, ts: p.startedAt, model, status, updatedAt: p.updatedAt,
        source: status === 'provisional' ? 'request-provisional' : status === 'manual' ? 'manual-request' : 'model-metadata',
        confidence: status === 'provisional' ? 'inferred' : status === 'manual' ? 'manual' : p.confidence,
        assistantId: p.assistantId, conversationId: p.conversationId, requestedModel: p.requestedModel,
        rawModel: p.actualModel, modelEvidence: p.actualModelPath, route: p.route,
      });
      if (old) state.records[state.records.indexOf(old)] = record; else state.records.push(record);
    } else if (old) state.records = state.records.filter(r => r.requestId !== p.requestId);
    p.countState = decision;
    // Snapshot of both the request and its accounting entry (null is a tombstone).
    writeRequestJournal(p);
    const changed = beforeModel !== model || beforeStatus !== (model ? status : null);
    if (changed) {
      const result = !model ? 'rollback' : beforeModel && beforeModel !== model ? 'reclassified'
        : status === 'provisional' ? 'provisional' : 'confirmed';
      eventLog(p, result, reason || decision);
      if (!model) showToast('已撤销此条估算；详见识别日志', 'warning');
      else if (beforeModel && beforeModel !== model) showToast(`已改归 ${modelDisplayName(model)}；合计不重复增加`, 'neutral');
      else if (status === 'provisional') showToast(`${modelDisplayName(model)} 已暂记 +1（不用等回复）`, 'success');
      else if (beforeModel) showToast('实际模型已确认；用量不再 +1', 'success');
      else showToast(`${modelDisplayName(model)} 已确认 +1`, 'success');
    }
    saveStateSoon(); render();
  }

  function manualResolveRequest(p, choice) {
    const updated = upsertPending({ ...p, manualDecision: choice, rejected: false }, choice === 'ignore' ? 'ignored' : 'manual');
    ui.inFlight.delete(p.requestId);
    syncAccounting(updated, choice === 'ignore' ? 'manual-request-removed' : 'manual-request-classified');
  }

  function handleGenerationEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'hook-ready') {
      ui.hookReady = payload.fetchAttached !== false; ui.hookVersion = String(payload.hookVersion || ''); render(); return;
    }
    if (payload.type === 'route-changed') { ensureUiAttached(); render(); return; }
    if (payload.type === 'hook-diagnostic') { eventLog(payload, 'diagnostic', payload.reason); return; }
    if (payload.type === 'model-hints') { handleModelHints(payload); return; }
    if (payload.type === 'conversation-snapshot') { reconcileSnapshot(payload); return; }
    if (!payload.requestId) return;
    const id = String(payload.requestId);
    let tracked = pendingById(id);
    if (payload.type === 'generation-started') {
      if (tracked || state.records.some(r => r.requestId === id)) return;
      ui.hookReady = true; ui.lastRequestAt = Number(payload.startedAt) || Date.now();
      // Only an explicit client-generated attempt ID is eligible for dispatch
      // deduplication. Do not mistake a reused user message ID for the same run.
      const attemptKey = payload.clientRequestId ? JSON.stringify([
        payload.clientRequestId, payload.action || 'next', payload.userMessageId || '', payload.conversationId || '',
        payload.requestedModel || '', payload.thinkingEffort || '',
      ]) : '';
      const duplicate = attemptKey ? state.pending.find(p => p.attemptKey === attemptKey && !p.duplicateOf && !p.rejected) : null;
      const p = upsertPending({ ...payload, countingMode: state.settings.countingMode,
        attemptKey, duplicateOf: duplicate?.requestId || '', rejected: payload.preAborted === true }, 'sent');
      if (!duplicate && !p.rejected) ui.inFlight.set(id, {startedAt: p.startedAt, requestedModel:p.requestedModel});
      eventLog(p, 'started', duplicate ? 'same-client-attempt-id' : 'request-captured');
      syncAccounting(p, 'request-dispatched');
      if (!recordForRequest(id) && !duplicate && !p.rejected) showToast('已捕获请求；等待可识别的实际模型', 'neutral');
      saveStateNow(); return;
    }
    // Responses/telemetry/history alone never invent a missing generation attempt.
    if (!tracked) return;
    if (tracked.duplicateOf) {
      const canonical = pendingById(tracked.duplicateOf);
      if (canonical) handleGenerationEvent({ ...payload, requestId: canonical.requestId, startedAt: canonical.startedAt });
      return;
    }
    if (tracked.manualDecision) { ui.inFlight.delete(id); return; }
    if (payload.type === 'generation-progress') {
      const stage = payload.stage || 'receiving';
      const headers = stage === 'response-headers';
      const status = Number(payload.httpStatus) || tracked.httpStatus;
      const p = upsertPending({ ...payload, httpStatus: status,
        accepted: tracked.accepted || (headers && status >= 200 && status < 300),
        rejected: tracked.rejected || (headers && status >= 400),
      }, stage);
      eventLog(p, 'progress', stage);
      syncAccounting(p, headers && status >= 400 ? `http-${status}` : 'model-metadata-observed');
      saveStateNow(); return;
    }
    if (payload.type !== 'generation-finished') return;
    ui.hookReady = true; ui.inFlight.delete(id);
    const explicitFailure = /^http-[1-9]\d*$/.test(payload.reason || '') || payload.reason === 'not-dispatched-aborted'
      || (payload.reason === 'response-failed' && !tracked.assistantSeen && !tracked.actualModel);
    const p = upsertPending({ ...payload,
      rejected: tracked.rejected || explicitFailure,
      responseComplete: tracked.responseComplete || payload.success === true,
    }, payload.success ? 'completed' : explicitFailure ? 'rejected' : 'awaiting');
    syncAccounting(p, payload.reason || (payload.success ? 'generation-completed' : 'transport-result-unknown'));
    eventLog(p, payload.success ? 'completed' : explicitFailure ? 'not-counted' : 'awaiting', payload.reason || 'transport-result-unknown');
    // The request record stays: later actual/resolved metadata may correct its
    // model. A closed stream is neither a +1 event nor an automatic refund.
    saveStateNow(); render();
  }


  function reconcileSnapshot(payload) {
    if (!Array.isArray(payload.nodes) || !state.pending.length) return;
    const nodes = payload.nodes.slice(0, 10000), index = new Map(nodes.map(n => [n.nodeId, n]));
    for (const pending of [...state.pending]) {
      if (pending.manualDecision || pending.rejected || pending.duplicateOf) continue;
      if (pending.conversationId && pending.conversationId !== payload.conversationId) continue;
      const reusedUserId = pending.userMessageId && state.pending.filter(p => !p.duplicateOf && p.userMessageId === pending.userMessageId
        && (!p.conversationId || p.conversationId === payload.conversationId)).length > 1;
      const candidates = [];
      for (const n of nodes) {
        const m = n.message;
        if (n.role !== 'assistant' || !m?.id) continue;
        let matches = pending.assistantId === m.id;
        if (!matches && !reusedUserId && pending.userMessageId && Number(m.create_time)) {
          const created = Number(m.create_time) < 1e12 ? Number(m.create_time)*1000 : Number(m.create_time);
          if (created < pending.startedAt - 5000) continue;
          let current = n, visited = new Set();
          for (let i=0; current && i<120 && !visited.has(current.nodeId); i++) {
            visited.add(current.nodeId); current = index.get(current.parent);
            if (current?.role === 'user') { matches = current.messageId === pending.userMessageId; break; }
          }
        }
        if (matches) candidates.push(m);
      }
      // Prefer the exact previously-observed assistant ID; otherwise do not
      // choose among regenerated branches. No history-wide blind backfill.
      const exact = candidates.filter(m => m.id === pending.assistantId);
      const chosen = exact.length === 1 ? exact : candidates;
      if (chosen.length !== 1) continue;
      const message = chosen[0], meta = message.metadata || {};
      const fields = [
        ['snapshot.metadata.resolved_model_slug', meta.resolved_model_slug],
        ['snapshot.metadata.actual_model_slug', meta.actual_model_slug],
        ['snapshot.metadata.server_ste_metadata.model_slug', meta.server_reported_model],
        ['snapshot.metadata.actual_model', meta.actual_model], ['snapshot.metadata.resolved_model',meta.resolved_model],
        ['snapshot.metadata.model_slug', meta.model_slug], ['snapshot.metadata.model', meta.model],
        ['snapshot.resolved_model_slug',message.resolved_model_slug], ['snapshot.model_slug',message.model_slug],
      ].filter(([,value]) => typeof value === 'string' && value);
      fields.sort((a,b) => evidenceRank(b[0])-evidenceRank(a[0]));
      if (!fields.length) continue;
      const [path, actualModel] = fields[0];
      handleGenerationEvent({requestId: pending.requestId, type:'generation-progress', stage:'passive-snapshot',
        actualModel, actualModelPath:path, confidence:'actual', assistantSeen:true, assistantId:message.id,
        actualThinkingEffort: meta.thinking_effort || meta.reasoning_effort || '', conversationId:payload.conversationId});
    }
  }

  function addUsageRecord(model, extras = {}) {
    const record = normalizeRecord({
      id: cryptoRandomId(),
      ts: Number(extras.ts) || Date.now(),
      model,
      status: extras.status || (extras.source === 'manual' || !extras.requestId ? 'manual' : 'confirmed'),
      updatedAt: Number(extras.updatedAt) || Date.now(),
      requestId: extras.requestId || '',
      source: extras.source || 'manual',
      confidence: extras.confidence || 'manual',
      eventKey: extras.eventKey || `manual:${cryptoRandomId()}`,
      assistantId: extras.assistantId || '',
      conversationId: extras.conversationId || '',
      requestedModel: extras.requestedModel || '',
      rawModel: extras.rawModel || '',
      modelEvidence: extras.modelEvidence || '',
      route: extras.route || location.pathname,
    });
    if (!record) return;
    if (record.eventKey && state.records.some((item) => item.eventKey === record.eventKey)) return;
    state.records.push(record);
    saveStateSoon();
    render();
  }

  function addLog(raw) {
    const log = normalizeLog({ id: cryptoRandomId(), ...raw });
    if (!log) return;
    state.logs.push(log);
    state.logs = state.logs.slice(-MAX_LOGS);
    saveStateSoon();
    render();
  }

  function modelDisplayName(model) {
    return model === 'gpt6' ? 'GPT-6 Pro' : 'GPT-5.6 Sol Pro';
  }

  function getBoundaries(now = Date.now()) {
    const dayStart = state.settings.dayWindow === 'localDay'
      ? localDayStart(now)
      : now - DAY_MS;
    const weekStart = state.settings.weekWindow === 'localWeek'
      ? localWeekStart(now)
      : now - WEEK_MS;
    return { now, dayStart, weekStart };
  }

  function localDayStart(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function localWeekStart(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay();
    const daysSinceMonday = (day + 6) % 7;
    date.setDate(date.getDate() - daysSinceMonday);
    return date.getTime();
  }

  function nextLocalDayStart(timestamp) {
    const date = new Date(timestamp);
    date.setHours(24, 0, 0, 0);
    return date.getTime();
  }

  function nextLocalWeekStart(timestamp) {
    const start = localWeekStart(timestamp);
    const next = new Date(start); next.setDate(next.getDate() + 7); return next.getTime();
  }

  function getMetrics(now = Date.now()) {
    const { dayStart, weekStart } = getBoundaries(now);
    const usable = state.records.filter((record) => record.ts <= now);
    const day = usable.filter((record) => (state.settings.dayWindow === 'localDay' ? record.ts >= dayStart : record.ts > dayStart));
    const week = usable.filter((record) => state.settings.weekWindow === 'localWeek' ? record.ts >= weekStart : record.ts > weekStart);

    const count = (records, model) => records.reduce((sum, record) => sum + (record.model === model ? 1 : 0), 0);
    const dayGpt6 = count(day, 'gpt6');
    const daySol = count(day, 'solpro');
    const weekGpt6 = count(week, 'gpt6');
    const weekSol = count(week, 'solpro');
    const dayTotal = dayGpt6 + daySol;
    const weekTotal = weekGpt6 + weekSol;

    const result = {
      now,
      dayStart,
      weekStart,
      day,
      week,
      dayGpt6,
      daySol,
      weekGpt6,
      weekSol,
      dayTotal,
      weekTotal,
      plan: state.settings.plan,
      provisionalCount: usable.filter(r => r.status === 'provisional' && (state.settings.plan === 'pro100' || r.model === 'gpt6' ? r.ts > weekStart : r.ts > dayStart)).length,
      unresolvedRecent: unresolvedRequests().filter(p => !recordForRequest(p.requestId) && p.startedAt >= dayStart).length,
    };

    if (state.settings.plan === 'pro200') {
      // Pro $200 的三条公开限制：
      // 1) GPT-6 Pro 每周 200；2) GPT-5.6 Sol Pro 每日 170；
      // 3) GPT-6 Pro + GPT-5.6 Sol Pro 每日合计 200。
      result.remainingCombinedDay = Math.max(0, 200 - dayTotal);
      result.remainingSolDay = Math.max(0, 170 - daySol);
      result.remainingGpt6Week = Math.max(0, 200 - weekGpt6);
      result.canGpt6 = Math.min(result.remainingCombinedDay, result.remainingGpt6Week);
      result.canSol = Math.min(result.remainingCombinedDay, result.remainingSolDay);
      result.closest = closestLimit([
        { label: '今日总用量', used: dayTotal, limit: 200 },
        { label: 'GPT-5.6 Pro 今日用量', used: daySol, limit: 170 },
        { label: 'GPT-6 Pro 周限额', used: weekGpt6, limit: 200 },
      ]);
    } else {
      result.remainingSharedWeek = Math.max(0, 50 - weekTotal);
      result.canGpt6 = result.remainingSharedWeek;
      result.canSol = result.remainingSharedWeek;
      result.closest = closestLimit([
        { label: weekLabel('共享'), used: weekTotal, limit: 50 },
      ]);
    }

    result.next = calculateNextRelease(result);
    return result;
  }

  function closestLimit(items) {
    const enriched = items.map((item) => ({
      ...item,
      ratio: item.limit > 0 ? item.used / item.limit : 0,
      remaining: Math.max(0, item.limit - item.used),
    }));
    const highest = [...enriched].sort((a, b) => b.ratio - a.ratio)[0];
    if (!highest || highest.used === 0) return null;
    return highest;
  }

  function calculateNextRelease(metrics) {
    const byTs = (a, b) => a.ts - b.ts;
    const oldestDayAny = [...metrics.day].sort(byTs)[0] || null;
    const oldestDaySol = [...metrics.day].filter((record) => record.model === 'solpro').sort(byTs)[0] || null;
    const oldestWeekGpt6 = [...metrics.week].filter((record) => record.model === 'gpt6').sort(byTs)[0] || null;
    const oldestWeekAny = [...metrics.week].sort(byTs)[0] || null;

    return {
      dayAny: state.settings.dayWindow === 'rolling24'
        ? (oldestDayAny ? oldestDayAny.ts + DAY_MS : null)
        : nextLocalDayStart(metrics.now),
      daySol: state.settings.dayWindow === 'rolling24'
        ? (oldestDaySol ? oldestDaySol.ts + DAY_MS : null)
        : nextLocalDayStart(metrics.now),
      weekGpt6: state.settings.weekWindow === 'rolling7'
        ? (oldestWeekGpt6 ? oldestWeekGpt6.ts + WEEK_MS : null)
        : nextLocalWeekStart(metrics.now),
      weekAny: state.settings.weekWindow === 'rolling7'
        ? (oldestWeekAny ? oldestWeekAny.ts + WEEK_MS : null)
        : nextLocalWeekStart(metrics.now),
    };
  }

  function dayLabel(suffix = '') {
    return `${state.settings.dayWindow === 'rolling24' ? '24h' : '今日'}${suffix ? ` ${suffix}` : ''}`;
  }

  function weekLabel(suffix = '') {
    return `${state.settings.weekWindow === 'rolling7' ? '7日' : '本周'}${suffix ? ` ${suffix}` : ''}`;
  }

  function severity(used, limit) {
    const ratio = limit > 0 ? used / limit : 0;
    if (ratio >= 0.95) return 'danger';
    if (ratio >= 0.8) return 'warning';
    return 'normal';
  }

  function percentage(used, limit) {
    if (!limit) return 0;
    return Math.max(0, Math.min(100, (used / limit) * 100));
  }

  function installMenuCommands() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('显示/隐藏 Chat Pro 用量面板', () => {
      state.settings.hidden = !state.settings.hidden;
      saveStateSoon();
      render();
    });
    GM_registerMenuCommand('GPT-6 Pro 手动 +1', () => manualAdd('gpt6'));
    GM_registerMenuCommand('GPT-5.6 Sol Pro 手动 +1', () => manualAdd('solpro'));
    GM_registerMenuCommand('导出用量 JSON', exportData);
    GM_registerMenuCommand('恢复默认面板大小与位置', () => resetPanelSize(true));
  }

  function bootUi() {
    const start = () => {
      if (!document.body) {
        requestAnimationFrame(start);
        return;
      }
      createUi();
      render();
      clearInterval(renderTimer);
      renderTimer = setInterval(() => {
        ensureUiAttached();
        if (ui.view === 'main') render();
      }, 30_000);
    };
    start();
  }

  function createUi() {
    if (!isActiveUiOwner()) return;
    if (host && host.isConnected) return;

    // When an older copy is still active in the same tab, both panels would
    // otherwise overlap exactly. The newest instance owns the UI and removes
    // stale hosts; the page-level owner token prevents older v2 instances from
    // removing a newer panel in return.
    document.querySelectorAll(`#${APP_ID}`).forEach((element) => {
      if (element !== host) element.remove();
    });

    host = document.createElement('div');
    host.id = APP_ID;
    host.dataset.owner = channel;
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    host.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.addEventListener('click', onUiClick);
    shadow.addEventListener('change', onUiChange);
    shadow.addEventListener('input', onUiInput);
    shadow.addEventListener('pointerdown', onPointerDown);
    shadow.addEventListener('dblclick', e => { if (e.target.closest('[data-resize-handle]')) resetPanelSize(); });
    shadow.addEventListener('keydown', onResizeKey);
    document.body.appendChild(host);
    window.addEventListener('resize', () => { applyPanelScale(); applyStoredPosition(); });
    applyStoredPosition();

    if (!uiObserver) {
      uiObserver = new MutationObserver(() => {
        if (!isActiveUiOwner()) return;
        document.querySelectorAll(`#${APP_ID}`).forEach((element) => {
          if (element !== host) element.remove();
        });
      });
      uiObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function ensureUiAttached() {
    if (!isActiveUiOwner()) {
      if (host && host.isConnected) host.remove();
      return;
    }
    if (!host || !host.isConnected) createUi();
  }

  function applyStoredPosition() {
    if (!host) return;
    const position = state.settings.position;
    if (position) {
      const clamped = clampPosition(position.left, position.top);
      host.style.left = `${clamped.left}px`;
      host.style.top = `${clamped.top}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    } else {
      host.style.left = 'auto';
      host.style.top = '72px';
      host.style.right = '18px';
      host.style.bottom = 'auto';
    }
  }

  function clampPosition(left, top) {
    const rect = host?.getBoundingClientRect();
    const width = rect?.width || 300, height = rect?.height || 200;
    return {
      left: Math.max(8, Math.min(Number(left) || 8, Math.max(8, window.innerWidth - width - 8))),
      top: Math.max(8, Math.min(Number(top) || 8, Math.max(8, window.innerHeight - height - 8))),
    };
  }

  function applyPanelScale() {
    if (!host || !shadow) return;
    const wrap = shadow.querySelector('.panel-wrap'), panel = shadow.querySelector('.panel');
    if (!wrap || !panel) return;
    const preferred = normalizePanelScale(state.settings.panelScale);
    const effective = Math.max(0.3, Math.min(preferred, (window.innerWidth - 16) / 300));
    // Zoom changes layout and text together, unlike resizing an empty outer box.
    wrap.style.zoom = String(effective);
    panel.style.maxHeight = `${Math.max(100, (window.innerHeight - 16) / effective)}px`;
    host.dataset.effectiveScale = String(effective);
    const label = shadow.querySelector('[data-scale-label]');
    if (label) label.textContent = `${Math.round(preferred * 100)}%`;
    const output = shadow.querySelector('[data-scale-output]');
    if (output) output.textContent = `${Math.round(preferred * 100)}%`;
    const rect = host.getBoundingClientRect();
    const clamped = clampPosition(rect.left, rect.top);
    if (rect.right > window.innerWidth - 8 || rect.bottom > window.innerHeight - 8 || rect.left < 8 || rect.top < 8) {
      host.style.left = `${clamped.left}px`; host.style.top = `${clamped.top}px`;
      host.style.right = 'auto'; host.style.bottom = 'auto';
    }
  }
  function setPanelScale(value) {
    state.settings.panelScale = normalizePanelScale(value);
    applyPanelScale(); saveStateSoon();
  }
  function resetPanelSize(positionToo = false) {
    state.settings.panelScale = 1;
    if (positionToo) { state.settings.position = null; state.settings.hidden = false; }
    saveStateNow(); render(); applyStoredPosition(); applyPanelScale();
  }
  function onResizeKey(event) {
    if (!event.target.closest('[data-resize-handle]')) return;
    if (!['ArrowLeft','ArrowDown','ArrowRight','ArrowUp','Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Home') resetPanelSize();
    else setPanelScale(state.settings.panelScale + (['ArrowRight','ArrowUp'].includes(event.key) ? 0.05 : -0.05));
    saveStateNow();
  }
  function onPointerDown(event) {
    const resizeHandle = event.target.closest('[data-resize-handle]');
    const slider = event.target.closest('[data-size-slider]');
    const dragHandle = event.target.closest('[data-drag-handle]');
    if (event.button !== 0 || (!resizeHandle && !slider && !dragHandle)) return;
    if (!resizeHandle && !slider && event.target.closest('button, select, input, label, a, [data-action]')) return;
    ui.pointerBusy = true;
    const rect = host.getBoundingClientRect();
    const x = event.clientX, y = event.clientY, startScale = Number(host.dataset.effectiveScale) || 1;
    if (!slider) {
      event.preventDefault(); event.stopPropagation();
      try { (resizeHandle || dragHandle).setPointerCapture(event.pointerId); } catch (_) {}
      host.style.left = `${rect.left}px`; host.style.top = `${rect.top}px`;
      host.style.right = 'auto'; host.style.bottom = 'auto';
    }
    let moved = false;
    const move = e => {
      if (e.pointerId !== event.pointerId || slider) return;
      if (Math.abs(e.clientX - x) + Math.abs(e.clientY - y) > 2) moved = true;
      if (resizeHandle) {
        const dx = e.clientX - x, dy = e.clientY - y;
        const ratio = 1 + (rect.width * dx + rect.height * dy) / (rect.width ** 2 + rect.height ** 2);
        setPanelScale(Math.round(startScale * ratio * 100) / 100);
      } else {
        const next = clampPosition(rect.left + e.clientX - x, rect.top + e.clientY - y);
        host.style.left = `${next.left}px`; host.style.top = `${next.top}px`;
      }
    };
    const end = e => {
      if (e && e.pointerId !== undefined && e.pointerId !== event.pointerId) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('blur', end);
      if (!slider) {
        const finalRect = host.getBoundingClientRect();
        state.settings.position = clampPosition(finalRect.left, finalRect.top);
      }
      // Keep nodes mounted during a drag; incoming request events still update data.
      const needsRender = moved || ui.renderQueued;
      ui.pointerBusy = false; ui.renderQueued = false;
      saveStateNow(); if (needsRender) render();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('blur', end);
  }

  function render() {
    if (!isActiveUiOwner()) {
      if (host && host.isConnected) host.remove();
      return;
    }
    if (!shadow || !host) return;
    if (ui.pointerBusy) { ui.renderQueued = true; return; }
    host.style.display = state.settings.hidden ? 'none' : 'block';
    if (state.settings.hidden) return;

    const metrics = getMetrics();
    shadow.innerHTML = `${baseStyles()}${renderPanel(metrics)}`;
    applyPanelScale();
    applyStoredPosition();
    applyStoredPositionIfOffscreen();
  }

  function applyStoredPositionIfOffscreen() {
    if (!host) return;
    const rect = host.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8 || rect.bottom > window.innerHeight - 8 || rect.left < 8 || rect.top < 8) {
      const pos = clampPosition(rect.left, rect.top);
      host.style.left = `${pos.left}px`; host.style.top = `${pos.top}px`;
      host.style.right = 'auto'; host.style.bottom = 'auto';
    }
  }

  function baseStyles() {
    return `
      <style>
        :host {
          all: initial;
          color-scheme: dark;
          --panel-bg: rgba(20, 21, 23, 0.975);
          --panel-bg-soft: rgba(255, 255, 255, 0.045);
          --panel-border: rgba(255, 255, 255, 0.13);
          --card-border: rgba(255, 255, 255, 0.10);
          --text: #f3f4f6;
          --muted: #a7abb4;
          --muted-2: #747985;
          --gold: #f6c453;
          --green: #38e59d;
          --blue: #55b9ff;
          --warning: #f0a83b;
          --danger: #ef6262;
        }
        *, *::before, *::after { box-sizing: border-box; }
        button, select, input { font: inherit; }
        button { -webkit-tap-highlight-color: transparent; }
        .size-footer { position: relative; display: flex; align-items: center; justify-content: flex-end;
          gap: 5px; padding-right: 22px; min-height: 19px; }
        .size-footer .script-version { padding: 2px 0 4px; }
        .scale-label { border: 0; background: none; color: var(--muted-2); font-size: 8px; padding: 2px;
          cursor: pointer; font-variant-numeric: tabular-nums; }
        .resize-handle { position: absolute; right: 2px; bottom: 1px; width: 20px; height: 20px;
          display: grid; place-items: center; border: 0; background: transparent; color: #a7abb4;
          cursor: nwse-resize; touch-action: none; border-radius: 4px; padding: 0; }
        .resize-handle:hover, .resize-handle:focus-visible { background: #ffffff16; color: #fff; }
        .resize-handle svg { width: 12px; height: 12px; pointer-events: none; }
        .header { touch-action: none; }
        input[type="range"] { width: 100%; accent-color: #55b9ff; }
        .panel-wrap { position: relative; }
        .panel {
          width: 300px;
          max-width: none;
          color: var(--text);
          background:
            radial-gradient(circle at 8% 0%, rgba(117, 107, 255, 0.10), transparent 30%),
            linear-gradient(155deg, rgba(26, 27, 30, 0.985), var(--panel-bg));
          border: 1px solid var(--panel-border);
          border-radius: 13px;
          box-shadow: 0 22px 64px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255,255,255,0.035);
          overflow: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
          font-size: 10px;
          line-height: 1.38;
          backdrop-filter: blur(18px) saturate(135%);
        }
        @media (max-width: 330px) {
          .panel { border-radius: 12px; }
        }
        .header {
          position: relative;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 9px 6px;
          user-select: none;
          cursor: grab;
        }
        .header:active { cursor: grabbing; }
        .brand-mark {
          width: 24px;
          height: 24px;
          flex: 0 0 24px;
          display: grid;
          place-items: center;
          border-radius: 7px;
          color: #bbb8ff;
          background: linear-gradient(145deg, rgba(120,113,255,.24), rgba(255,255,255,.065));
          border: 1px solid rgba(190,187,255,.13);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.05);
        }
        .title-wrap { min-width: 0; flex: 1; }
        .title {
          color: #f7f7f8;
          font-weight: 760;
          font-size: 13.5px;
          letter-spacing: -0.25px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .subtitle {
          margin-top: 1px;
          color: var(--muted);
          font-size: 9.5px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .header-actions { display: flex; align-items: center; gap: 4px; }
        .running {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          color: #45dc91;
          font-size: 9.5px;
          white-space: nowrap;
        }
        .running-dot {
          width: 6px;
          height: 6px;
          border-radius: 999px;
          background: #32df86;
          box-shadow: 0 0 0 4px rgba(50,223,134,.10), 0 0 12px rgba(50,223,134,.45);
        }
        .running.busy { color: #67c4ff; }
        .running.busy .running-dot {
          background: #55b9ff;
          box-shadow: 0 0 0 4px rgba(85,185,255,.10), 0 0 12px rgba(85,185,255,.45);
          animation: pulse-dot 1.15s ease-in-out infinite;
        }
        .running.waiting { color: #9ca1ab; }
        .running.waiting .running-dot {
          background: #8a909b;
          box-shadow: 0 0 0 4px rgba(138,144,155,.08);
        }
        @keyframes pulse-dot { 50% { opacity: .45; transform: scale(.8); } }
        .icon-btn {
          width: 24px;
          height: 24px;
          display: grid;
          place-items: center;
          padding: 0;
          border: 0;
          border-radius: 7px;
          cursor: pointer;
          color: #c8cad0;
          background: transparent;
          transition: background .16s ease, color .16s ease;
        }
        .icon-btn:hover { color: #fff; background: rgba(255,255,255,.075); }
        .body { padding: 0 9px 7px; }
        .section { display: grid; gap: 5px; }
        .metric-card {
          --accent: var(--green);
          position: relative;
          padding: 7px 8px 6px;
          border: 1px solid var(--card-border);
          border-radius: 9px;
          background: linear-gradient(145deg, rgba(255,255,255,.052), rgba(255,255,255,.025));
          box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
          overflow: hidden;
        }
        .metric-card.weekly { --accent: var(--gold); border-color: rgba(246,196,83,.16); }
        .metric-card.sol-daily { --accent: var(--blue); border-color: rgba(85,185,255,.16); }
        .metric-card.total { --accent: var(--green); border-color: rgba(56,229,157,.13); }
        .metric-card.shared { --accent: #a99cff; border-color: rgba(169,156,255,.16); }
        .metric-card.warning { --accent: var(--warning); border-color: rgba(240,168,59,.28); }
        .metric-card.danger { --accent: var(--danger); border-color: rgba(239,98,98,.36); }
        .metric-top {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .metric-icon {
          width: 24px;
          height: 24px;
          flex: 0 0 24px;
          display: grid;
          place-items: center;
          border-radius: 50%;
          color: var(--accent);
          background: color-mix(in srgb, var(--accent) 14%, transparent);
        }
        @supports not (background: color-mix(in srgb, white 10%, transparent)) {
          .metric-icon { background: rgba(255,255,255,.065); }
        }
        .metric-label {
          min-width: 0;
          flex: 1;
          color: #f2f3f5;
          font-size: 11.5px;
          font-weight: 690;
          letter-spacing: -0.15px;
        }
        .metric-value-wrap {
          flex: 0 0 auto;
          display: grid;
          justify-items: end;
          gap: 2px;
          white-space: nowrap;
        }
        .metric-value {
          color: var(--accent);
          font-size: 16px;
          line-height: 1;
          font-weight: 780;
          font-variant-numeric: tabular-nums;
          letter-spacing: -0.45px;
          white-space: nowrap;
        }
        .metric-value span { color: #b3b7c1; font-weight: 620; font-size: 13px; }
        .metric-remain {
          color: var(--muted);
          font-size: 8.8px;
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }
        .metric-remain strong { color: #cfd1d6; font-weight: 650; }
        .bar-track {
          height: 4px;
          margin-top: 5px;
          overflow: hidden;
          border-radius: 999px;
          background: rgba(255,255,255,.105);
          box-shadow: inset 0 1px 2px rgba(0,0,0,.30);
        }
        .bar-fill {
          width: 0;
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 92%, white 8%), var(--accent));
          box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 30%, transparent);
          transition: width .24s ease;
        }
        @supports not (background: color-mix(in srgb, white 10%, transparent)) {
          .bar-fill { background: var(--accent); box-shadow: none; }
        }
        .metric-foot {
          display: flex;
          justify-content: space-between;
          gap: 9px;
          margin-top: 4px;
          color: var(--muted);
          font-size: 9.5px;
          font-variant-numeric: tabular-nums;
        }
        .metric-foot strong { color: #cfd1d6; font-weight: 620; }
        .limit-note {
          display: flex;
          align-items: flex-start;
          gap: 5px;
          padding: 1px 1px 0;
          color: #b0b3bc;
          font-size: 9.5px;
        }
        .limit-note svg { flex: 0 0 auto; margin-top: 1px; color: #c2c6cf; }
        .unresolved-note {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          align-self: flex-start;
          padding: 3px 6px;
          border-radius: 999px;
          color: #efc66a;
          background: rgba(239,198,106,.09);
          font-size: 9px;
        }
        .footer-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          padding-top: 7px;
          border-top: 1px solid rgba(255,255,255,.09);
        }
        .model-switch-actions {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
        }
        .model-switch-btn {
          min-height: 29px;
          padding: 0 8px;
          border: 1px solid rgba(85,185,255,.27);
          border-radius: 7px;
          color: #dceeff;
          background: rgba(85,185,255,.08);
          cursor: pointer;
          font-size: 10px;
          font-weight: 700;
        }
        .model-switch-btn:hover:not(:disabled) { background: rgba(85,185,255,.15); border-color: rgba(85,185,255,.42); }
        .model-switch-btn:focus-visible { outline: 2px solid rgba(85,185,255,.72); outline-offset: 2px; }
        .model-switch-btn:disabled { color: var(--muted); background: rgba(255,255,255,.035); border-color: rgba(255,255,255,.08); cursor: wait; }
        .footer-btn {
          min-height: 31px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          padding: 0 10px;
          border: 1px solid rgba(255,255,255,.11);
          border-radius: 7px;
          color: #f0f1f3;
          background: rgba(255,255,255,.045);
          cursor: pointer;
          font-size: 11.5px;
          font-weight: 620;
          transition: transform .14s ease, background .14s ease, border-color .14s ease;
        }
        .footer-btn:hover { background: rgba(255,255,255,.075); border-color: rgba(255,255,255,.17); }
        .footer-btn:active { transform: translateY(1px); }
        .collapsed-body { padding: 0 9px 7px; cursor: pointer; }
        .collapsed-switch-actions { padding: 0 9px 7px; }
        .collapsed-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; }
        .collapsed-grid.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .collapsed-grid.three .remaining-value { font-size: 12px; }
        @media (max-width: 410px) {
          .collapsed-grid.three { grid-template-columns: 1fr; }
        }
        .remaining-box {
          padding: 6px 7px;
          border: 1px solid rgba(255,255,255,.09);
          border-radius: 8px;
          background: rgba(255,255,255,.035);
        }
        .remaining-label { color: var(--muted); font-size: 8.5px; }
        .remaining-value { margin-top: 1px; color: #f3f4f6; font-size: 14px; font-weight: 760; font-variant-numeric: tabular-nums; }
        .overflow-menu {
          position: absolute;
          z-index: 20;
          top: 42px;
          right: 9px;
          width: 158px;
          padding: 4px;
          border: 1px solid rgba(255,255,255,.13);
          border-radius: 8px;
          background: rgba(35,36,40,.985);
          box-shadow: 0 16px 34px rgba(0,0,0,.42);
        }
        .overflow-item {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 7px;
          border: 0;
          border-radius: 8px;
          color: #e8e9ec;
          background: transparent;
          cursor: pointer;
          text-align: left;
          font-size: 9px;
        }
        .overflow-item:hover { background: rgba(255,255,255,.07); }
        .divider { height: 1px; margin: 4px 2px; background: rgba(255,255,255,.08); }
        .view-body { padding: 0 11px 11px; }
        .form { display: grid; gap: 9px; }
        .field { display: grid; gap: 5px; }
        .field label { color: #d8dade; font-size: 12px; font-weight: 640; }
        select, input[type="number"] {
          width: 100%;
          min-height: 31px;
          padding: 7px 9px;
          border: 1px solid rgba(255,255,255,.13);
          border-radius: 8px;
          color: #f0f1f3;
          background: rgba(255,255,255,.055);
          outline: none;
        }
        select:focus, input[type="number"]:focus { border-color: rgba(90,210,163,.55); box-shadow: 0 0 0 3px rgba(90,210,163,.10); }
        .modal-note {
          padding: 6px 7px;
          border: 1px solid rgba(255,255,255,.075);
          border-radius: 8px;
          color: var(--muted);
          background: rgba(255,255,255,.035);
          font-size: 9.5px;
        }
        .settings-group {
          display: grid;
          gap: 7px;
          padding: 9px;
          border: 1px solid rgba(255,255,255,.08);
          border-radius: 8px;
          background: rgba(255,255,255,.025);
        }
        .settings-group-title { color: #dfe1e5; font-size: 12px; font-weight: 680; }
        .button-row { display: flex; flex-wrap: wrap; gap: 7px; }
        .btn {
          appearance: none;
          min-height: 31px;
          padding: 5px 9px;
          border: 1px solid rgba(255,255,255,.13);
          border-radius: 8px;
          color: #e9eaed;
          background: rgba(255,255,255,.045);
          cursor: pointer;
          font-size: 9.5px;
        }
        .btn:hover { background: rgba(255,255,255,.075); }
        .btn.primary { color: #07150f; background: #42d69a; border-color: #42d69a; font-weight: 680; }
        .btn.danger { color: #ff9292; }
        .small { font-size: 10.5px; }
        .muted { color: var(--muted); }
        .badge {
          display: inline-flex;
          align-items: center;
          padding: 3px 7px;
          border-radius: 999px;
          font-size: 9px;
          background: rgba(255,255,255,.07);
        }
        .badge.warning { color: #efc66a; background: rgba(239,198,106,.09); }
        .log-list { max-height: 280px; overflow: auto; }
        .log-row { padding: 9px 2px; border-bottom: 1px solid rgba(255,255,255,.075); }
        .log-row:last-child { border-bottom: 0; }
        .log-top { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; }
        .log-model { margin-top: 3px; color: #d5d7dc; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; overflow-wrap: anywhere; }
        .script-version {
          padding: 0 9px 5px;
          color: #666b75;
          font-size: 8px;
          line-height: 1;
          text-align: right;
          user-select: text;
          font-variant-numeric: tabular-nums;
        }
        .toast {
          position: absolute;
          z-index: 30;
          left: 9px;
          right: 9px;
          bottom: 9px;
          padding: 7px 9px;
          border-radius: 8px;
          color: white;
          background: #444750;
          box-shadow: 0 10px 28px rgba(0,0,0,.36);
          font-size: 9.5px;
          text-align: center;
          pointer-events: none;
        }
        .toast.success { background: #167e5c; }
        .toast.warning { background: #9c690d; }
        .toast.danger { background: #a63c3c; }
      </style>
    `;
  }

  function renderPanel(metrics) {
    const toast = ui.toast ? `<div class="toast ${escapeHtml(ui.toast.kind)}">${escapeHtml(ui.toast.text)}</div>` : '';
    let body;
    if (ui.view === 'settings') body = renderSettings(metrics);
    else if (ui.view === 'calibration') body = renderCalibration(metrics);
    else if (ui.view === 'logs') body = renderLogs();
    else body = state.settings.collapsed ? renderCollapsed(metrics) : renderMain(metrics);

    return `<div class="panel-wrap"><div class="panel">${body}<div class="size-footer">
      <button class="scale-label" data-action="settings" data-scale-label title="设置面板大小">${Math.round(state.settings.panelScale * 100)}%</button>
      <div class="script-version">脚本 v${escapeHtml(VERSION)}</div>
      <button class="resize-handle" data-resize-handle aria-label="拖动缩放面板" title="拖动整体缩放；方向键微调；双击或 Home 恢复默认">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 13 13 4M9 13l4-4"/></svg>
      </button></div></div>${toast}</div>`;
  }

  function renderHeader(title, subtitle, actions = '') {
    return `
      <div class="header" data-drag-handle>
        <div class="brand-mark" aria-hidden="true">${iconSvg('analytics', 17)}</div>
        <div class="title-wrap">
          <div class="title">${escapeHtml(title)}</div>
          <div class="subtitle">${escapeHtml(subtitle)}</div>
        </div>
        <div class="header-actions">${actions}</div>
      </div>
    `;
  }

  function renderHookStatus() {
    const unresolved = unresolvedRequests();
    const active = [...ui.inFlight.keys()].filter(id => {
      const p = pendingById(id); return p && !p.manualDecision && !p.rejected && !p.duplicateOf;
    }).length;
    const text = !ui.hookReady ? '连接中' : active ? `进行中 ${active}` : unresolved.length ? `待核对 ${unresolved.length}` : '已挂接';
    const detail = `发送即暂记模式会把暂记纳入进度条。已确认仅表示模型标识已核对，不代表官方扣费确认。进行中 ${active}；待核对 ${unresolved.length}。点击看明细。`;
    return `<span class="running ${active || unresolved.length ? 'busy' : ''}" title="${escapeHtml(detail)}" data-action="logs" style="cursor:pointer"><span class="running-dot"></span>${escapeHtml(text)}</span>`;
  }

  function renderAccountingNote(metrics) {
    const mode = state.settings.countingMode === 'model-first' ? '等模型确认' : '发送即暂记';
    return `<div class="unresolved-note" data-action="logs" style="cursor:pointer" title="点此核对或撤销具体请求；模型确认不等于官方扣费确认">${escapeHtml(mode)} · 含暂记 ${metrics.provisionalCount} 条${metrics.unresolvedRecent ? ` · 未分类 ${metrics.unresolvedRecent}` : ''}</div>`;
  }

  function renderOverflowMenu() {
    if (!ui.menuOpen) return '';
    return `
      <div class="overflow-menu">
        <button class="overflow-item" data-action="collapse">${iconSvg('collapse', 16)} 收起面板</button>
        <button class="overflow-item" data-action="logs">${iconSvg('list', 16)} 模型识别日志</button>
        <button class="overflow-item" data-action="export">${iconSvg('download', 16)} 导出 JSON</button>
        <button class="overflow-item" data-action="reset-size">${iconSvg('refresh', 16)} 恢复默认大小</button>
        <div class="divider"></div>
        <button class="overflow-item" data-action="hide">${iconSvg('eyeOff', 16)} 隐藏面板</button>
      </div>
    `;
  }

  function renderCollapsed(metrics) {
    const actions = `
      ${renderHookStatus()}
      <button class="icon-btn" data-action="expand" title="展开">${iconSvg('expand', 18)}</button>
    `;
    return `
      ${renderHeader('Chat Pro 估算（本机）', compactWindowLabel(), actions)}
      <div class="collapsed-body" data-action="expand">
        <div class="collapsed-grid ${state.settings.plan === 'pro200' ? 'three' : ''}">
          <div class="remaining-box">
            <div class="remaining-label">${state.settings.plan === 'pro200' ? 'GPT-6 周用量' : '共享周用量'}</div>
            <div class="remaining-value">${formatCount(state.settings.plan === 'pro200' ? metrics.weekGpt6 : metrics.weekTotal)} / ${state.settings.plan === 'pro100' ? '50' : '200'}</div>
          </div>
          ${state.settings.plan === 'pro200' ? `
            <div class="remaining-box">
              <div class="remaining-label">5.6 今日用量</div>
              <div class="remaining-value">${formatCount(metrics.daySol)} / 170</div>
            </div>
          ` : ''}
          <div class="remaining-box">
            <div class="remaining-label">今日总用量</div>
            <div class="remaining-value">${formatCount(metrics.dayTotal)}${state.settings.plan === 'pro200' ? ' / 200' : ''}</div>
          </div>
        </div>
      </div>
      ${state.settings.plan === 'pro200' ? `<div class="collapsed-switch-actions">${renderModelSwitchActions()}</div>` : ''}
    `;
  }

  function renderMain(metrics) {
    const actions = `
      ${renderHookStatus()}
      <button class="icon-btn" data-action="toggle-menu" title="更多">${iconSvg('more', 18)}</button>
    `;

    return `
      ${renderHeader('Chat Pro 估算（本机）', compactWindowLabel(), actions)}
      ${renderOverflowMenu()}
      <div class="body">
        <div class="section">
          ${state.settings.plan === 'pro200' ? renderPro200Metrics(metrics) : renderPro100Metrics(metrics)}
          <div class="limit-note">${iconSvg('info', 14)}<span>${state.settings.plan === 'pro200'
            ? '5.6 无周限额，日限 170；两模型合计日限 200'
            : 'GPT-6 Pro 与 5.6 Pro 共用每周 50 条限额'}</span></div>
          ${renderAccountingNote(metrics)}
          ${state.settings.plan === 'pro200' ? renderModelSwitchActions() : ''}
          <div class="footer-actions">
            <button class="footer-btn" data-action="calibrate">${iconSvg('refresh', 15)} 校准</button>
            <button class="footer-btn" data-action="settings">${iconSvg('settings', 15)} 设置</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderModelSwitchActions() {
    const switching = Boolean(ui.modelSwitch);
    const button = (action, label) => `<button class="model-switch-btn" data-action="${action}"${switching ? ' disabled aria-busy="true"' : ''}>${switching ? '切换中…' : label}</button>`;
    return `<div class="model-switch-actions" aria-label="快速切换编辑器模型">
      ${button('quick-switch-gpt6', '6 Pro')}
      ${button('quick-switch-sol', '5.6 Pro')}
    </div>`;
  }

  function renderDashboardMetric({ label, used, limit, remain, kind, icon }) {
    const level = severity(used, limit);
    return `
      <div class="metric-card ${escapeHtml(kind)} ${escapeHtml(level)}">
        <div class="metric-top">
          <div class="metric-icon">${iconSvg(icon, 16)}</div>
          <div class="metric-label">${escapeHtml(label)}</div>
          <div class="metric-value-wrap">
            <div class="metric-value">${formatCount(used)} <span>/ ${formatCount(limit)}</span></div>
            <div class="metric-remain">剩余 <strong>${formatCount(remain)}</strong></div>
          </div>
        </div>
        <div class="bar-track" aria-label="${escapeHtml(label)} ${formatCount(used)} / ${formatCount(limit)}">
          <div class="bar-fill" style="width:${percentage(used, limit).toFixed(2)}%"></div>
        </div>
      </div>
    `;
  }

  function renderPro200Metrics(metrics) {
    return `
      ${renderDashboardMetric({
        label: 'GPT-6 Pro 周限额',
        used: metrics.weekGpt6,
        limit: 200,
        remain: metrics.remainingGpt6Week,
        kind: 'weekly',
        icon: 'crown',
      })}
      ${renderDashboardMetric({
        label: 'GPT-5.6 Pro 今日用量',
        used: metrics.daySol,
        limit: 170,
        remain: metrics.remainingSolDay,
        kind: 'sol-daily',
        icon: 'spark',
      })}
      ${renderDashboardMetric({
        label: '今日总用量',
        used: metrics.dayTotal,
        limit: 200,
        remain: metrics.remainingCombinedDay,
        kind: 'total',
        icon: 'bars',
      })}
    `;
  }

  function renderPro100Metrics(metrics) {
    return `
      ${renderDashboardMetric({
        label: '两模型共享周限额',
        used: metrics.weekTotal,
        limit: 50,
        remain: metrics.remainingSharedWeek,
        kind: 'shared',
        icon: 'crown',
      })}
      <div class="metric-card total">
        <div class="metric-top">
          <div class="metric-icon">${iconSvg('bars', 22)}</div>
          <div class="metric-label">今日总用量（观察）</div>
          <div class="metric-value">${formatCount(metrics.dayTotal)}</div>
        </div>
        <div class="metric-foot">
          <span>GPT-6 <strong>${formatCount(metrics.dayGpt6)}</strong></span>
          <span>5.6 <strong>${formatCount(metrics.daySol)}</strong></span>
        </div>
      </div>
    `;
  }

  function compactWindowLabel() {
    const day = state.settings.dayWindow === 'rolling24' ? '滚动 24h' : '本地自然日';
    const week = state.settings.weekWindow === 'rolling7' ? '滚动 7d' : '周一至周日';
    return `${day} / ${week}`;
  }

  function iconSvg(name, size = 18) {
    const attrs = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
    const paths = {
      analytics: '<path d="M4 19V9"/><path d="M10 19V5"/><path d="M16 19v-7"/><path d="M22 19V3"/>',
      crown: '<path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z"/><path d="M5 16h14"/>',
      bars: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20V7"/>',
      spark: '<path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z"/>',
      info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
      refresh: '<path d="M20 11a8 8 0 1 0 2 5"/><path d="M20 4v7h-7"/>',
      settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.09A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.09A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.17.37.37.7.6 1 .28.34.65.5 1.1.5H21v4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
      more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
      collapse: '<path d="M5 12h14"/>',
      expand: '<path d="m9 18 6-6-6-6"/>',
      list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
      download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
      eyeOff: '<path d="m3 3 18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A10.7 10.7 0 0 1 12 4c6 0 9 8 9 8a15.6 15.6 0 0 1-2.1 3.4"/><path d="M6.6 6.6C3.9 8.4 3 12 3 12s3 8 9 8a9.6 9.6 0 0 0 4.1-.9"/>',
      alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.6 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/>',
      back: '<path d="m15 18-6-6 6-6"/>',
    };
    return `<svg ${attrs}>${paths[name] || paths.analytics}</svg>`;
  }

  function renderSettings(metrics) {
    const actions = `<button class="icon-btn" data-action="back-main" title="返回">${iconSvg('back', 20)}</button>`;
    return `
      ${renderHeader('设置', '大小、窗口和本机数据', actions)}
      <div class="body">
        <div class="form">
          <div class="field">
            <label for="panel-size">面板整体大小 <output data-scale-output>${Math.round(state.settings.panelScale * 100)}%</output></label>
            <input id="panel-size" type="range" min="70" max="160" step="5" value="${Math.round(state.settings.panelScale * 100)}" data-size-slider>
            <div class="small muted">70%—160%；文字、卡片、按钮一起缩放。自动保存到本机。</div>
            <button class="btn" data-action="reset-size">恢复 100% 默认大小</button>
          </div>
          <div class="field">
            <label for="plan-select">套餐</label>
            <select id="plan-select" data-setting="plan">
              <option value="pro200" ${state.settings.plan === 'pro200' ? 'selected' : ''}>Pro $200：GPT-6 周 200；5.6 日 170；今日合计 200</option>
              <option value="pro100" ${state.settings.plan === 'pro100' ? 'selected' : ''}>Pro $100：两模型共用周 50</option>
            </select>
          </div>
          <div class="field">
            <label for="day-window-select">日窗口</label>
            <select id="day-window-select" data-setting="dayWindow">
              <option value="rolling24" ${state.settings.dayWindow === 'rolling24' ? 'selected' : ''}>滚动 24 小时（默认估算）</option>
              <option value="localDay" ${state.settings.dayWindow === 'localDay' ? 'selected' : ''}>本地自然日（00:00 重置）</option>
            </select>
          </div>
          <div class="field">
            <label for="week-window-select">周窗口</label>
            <select id="week-window-select" data-setting="weekWindow">
              <option value="rolling7" ${state.settings.weekWindow === 'rolling7' ? 'selected' : ''}>滚动 7×24 小时（默认估算）</option>
              <option value="localWeek" ${state.settings.weekWindow === 'localWeek' ? 'selected' : ''}>本地周一 00:00 至周日</option>
            </select>
          </div>
          <div class="field">
            <label for="counting-select">计数时机（修改只影响新请求）</label>
            <select id="counting-select" data-setting="countingMode">
              <option value="request-first" ${state.settings.countingMode === 'request-first' ? 'selected' : ''}>推荐：发送即暂记，实际模型到达后纠正</option>
              <option value="model-first" ${state.settings.countingMode === 'model-first' ? 'selected' : ''}>严格：首次实际模型确认即计数，不等结束</option>
            </select>
          </div>
          <div class="modal-note">
            插件只监听普通 Chat 的生成请求，忽略 Codex、Work、定时任务和自定义 GPT。默认发送即暂记；首次实际模型到达就确认或纠正，不等回复完成。网络断开/停止/切换对话不自动撤销；HTTP 明确失败会按本机策略撤销，非官方扣费结论。$200 档按三条限制估算：GPT-6 Pro 每周 200、GPT-5.6 Sol Pro 每日 170、两模型每日合计 200。只保存时间、模型、请求/回复 ID 与识别状态，不保存正文。
          </div>
          <div class="settings-group">
            <div class="settings-group-title">快速校正</div>
            <div class="button-row">
              <button class="btn" data-action="manual-add-gpt6">GPT-6 +1</button>
              <button class="btn" data-action="manual-remove-gpt6">GPT-6 −1</button>
              <button class="btn" data-action="manual-add-sol">5.6 +1</button>
              <button class="btn" data-action="manual-remove-sol">5.6 −1</button>
              <button class="btn" data-action="logs">识别日志</button>
            </div>
          </div>
          <div class="settings-group">
            <div class="settings-group-title">数据与面板</div>
            <div class="button-row">
              <button class="btn" data-action="export">导出 JSON</button>
              <button class="btn" data-action="import">导入 JSON</button>
              <button class="btn" data-action="clear-day">清空当前日窗</button>
              <button class="btn" data-action="reset-position">重置位置</button>
              <button class="btn danger" data-action="clear-all">清空全部</button>
            </div>
          </div>
          <input id="import-file" data-role="import-file" type="file" accept="application/json,.json" hidden>
          <div class="small muted">当前记录：${state.records.length} 条；${dayLabel()} ${metrics.dayTotal} 条；${weekLabel()} ${metrics.weekTotal} 条。</div>
        </div>
      </div>
    `;
  }

  function openCalibration() {
    const metrics = getMetrics();
    ui.calibration = state.settings.plan === 'pro200'
      ? {
          dayGpt6: String(metrics.dayGpt6),
          daySol: String(metrics.daySol),
          weekGpt6: String(metrics.weekGpt6),
        }
      : {
          weekGpt6: String(metrics.weekGpt6),
          weekSol: String(metrics.weekSol),
        };
    ui.view = 'calibration';
    render();
  }

  function renderCalibration() {
    const draft = ui.calibration || {};
    const actions = `<button class="icon-btn" data-action="back-main" title="返回">${iconSvg('back', 20)}</button>`;
    const fields = state.settings.plan === 'pro200'
      ? `
        ${numberField('cal-day-gpt6', `${dayLabel()} GPT-6 已用`, draft.dayGpt6, 'dayGpt6')}
        ${numberField('cal-day-sol', `${dayLabel()} 5.6 Sol Pro 已用`, draft.daySol, 'daySol')}
        ${numberField('cal-week-gpt6', `${weekLabel()} GPT-6 已用`, draft.weekGpt6, 'weekGpt6')}
      `
      : `
        ${numberField('cal-week-gpt6', `${weekLabel()} GPT-6 已用`, draft.weekGpt6, 'weekGpt6')}
        ${numberField('cal-week-sol', `${weekLabel()} 5.6 Sol Pro 已用`, draft.weekSol, 'weekSol')}
      `;

    return `
      ${renderHeader('校准本机计数', '用你在界面中看到的已用量覆盖当前窗口', actions)}
      <div class="body">
        <div class="form">
          ${fields}
          <div class="modal-note">
            为了同时校准 GPT-6 周限额、5.6 今日 170 条限额和两模型今日合计，今日用量需分别填写 GPT-6 与 5.6。校准只写入不含正文的合成记录，并关闭所校准窗口内的待确认请求，避免重复补记；周 GPT-6 已用不能小于今日 GPT-6 已用。
          </div>
          <div class="button-row">
            <button class="btn primary" data-action="apply-calibration">应用校准</button>
            <button class="btn" data-action="back-main">取消</button>
          </div>
        </div>
      </div>
    `;
  }

  function numberField(id, label, value, key) {
    return `
      <div class="field">
        <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
        <input id="${escapeHtml(id)}" type="number" min="0" max="5000" step="1" value="${escapeHtml(value || '0')}" data-calibration-key="${escapeHtml(key)}">
      </div>
    `;
  }

  function renderLogs() {
    const actions = `<button class="icon-btn" data-action="back-main" title="返回">${iconSvg('back', 20)}</button>`;
    const pendingRows = [...state.pending].filter(p => !p.manualDecision && !p.duplicateOf && !p.rejected && p.countState !== 'excluded').sort((a,b) => b.startedAt-a.startedAt).slice(0,60).map(p => `
      <div class="log-row">
        <div class="log-top"><span>${recordForRequest(p.requestId)?.status === 'confirmed' ? '模型已确认' : recordForRequest(p.requestId) ? '已暂记（包含在用量中）' : '未计数'} ${escapeHtml(p.requestedModel || '模型未知')}</span><span>${escapeHtml(p.requestId.slice(0,8))}</span></div>
        <div class="small muted">${escapeHtml(formatDateTime(p.startedAt))} · ${escapeHtml(p.stage)}</div>
        <div class="button-row">
          <button class="btn" data-action="resolve-pending-gpt6" data-request-id="${escapeHtml(p.requestId)}">归为 6（不重复加）</button>
          <button class="btn" data-action="resolve-pending-sol" data-request-id="${escapeHtml(p.requestId)}">归为 5.6（不重复加）</button>
          <button class="btn" data-action="ignore-pending" data-request-id="${escapeHtml(p.requestId)}">撤销此条</button>
        </div>
      </div>`).join('');
    const logs = [...state.logs].sort((a, b) => b.ts - a.ts).slice(0, 30);
    const rows = logs.length
      ? logs.map((log) => {
          const resultLabel = {
            started: '已捕获请求',
            progress: '已收到响应',
            'model-hint': '按消息 ID 补充模型',
            awaiting: '完成状态待确认',
            diagnostic: '监听诊断',
            counted: '已计数',
            provisional: '发送已暂记 +1', confirmed: '模型已确认（不再加一）', reclassified: '已纠正模型分类',
            rollback: '已撤销暂记', 'unknown-model': '模型尚未确认', completed: '生成结束（不重复加一）',
            'ignored-non-pro': '非 Pro，忽略',
            unresolved: '未识别',
            'not-counted': '未成功/未计数',
          }[log.result] || log.result;
          return `
            <div class="log-row">
              <div class="log-top"><span>${escapeHtml(resultLabel)}</span><span class="muted">${escapeHtml(formatDateTime(log.ts))}</span></div>
              <div class="log-model">请求：${escapeHtml(log.requestedModel || '—')}</div>
              <div class="log-model">响应：${escapeHtml(log.actualModel || '—')}　[${escapeHtml(log.confidence || 'none')}]</div>
              <div class="small muted">${escapeHtml(log.reason || '')}</div>
              ${log.actualModelPath ? `<div class="small muted">字段：${escapeHtml(log.actualModelPath)}</div>` : ''}
              <div class="small muted">${escapeHtml(log.transport || '')} ${escapeHtml(log.requestUrlPath || '')}</div>
              <div class="small muted">请求 ${escapeHtml((log.requestId || '').slice(0, 8) || '—')} · 对话 ${escapeHtml((log.conversationId || '').slice(0, 8) || '新会话')}</div>
            </div>
          `;
        }).join('')
      : '<div class="modal-note">还没有识别日志。发送一次普通 Chat 后再回来查看。</div>';

    return `
      ${renderHeader('模型识别日志', '暂记 → 模型核对；不等回答结束', actions)}
      <div class="body">
        <div class="modal-note">模型待核对 ${unresolvedRequests().length} 条；暂记已纳入进度条。下方是最近 60 条请求，按钮更新原记录而非额外 +1。未知 WebSocket/Worker 通道未覆盖。</div>
        <div class="log-list">${pendingRows}${rows}</div>
        <div class="button-row" style="margin-top:8px">
          <button class="btn" data-action="clear-logs">清空日志</button>
          <button class="btn" data-action="export">导出 JSON</button>
        </div>
      </div>
    `;
  }

  function onUiClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (['resolve-pending-gpt6','resolve-pending-sol','ignore-pending'].includes(action)) {
      const pending = pendingById(target.dataset.requestId);
      if (!pending || pending.stage === 'ignored') return;
      ui.inFlight.delete(pending.requestId);
      if (action === 'ignore-pending') manualResolveRequest(pending, 'ignore');
      else manualResolveRequest(pending, action === 'resolve-pending-gpt6' ? 'gpt6' : 'solpro');
      saveStateNow(); render(); return;
    }

    if (action !== 'toggle-menu') ui.menuOpen = false;

    switch (action) {
      case 'toggle-menu':
        ui.menuOpen = !ui.menuOpen;
        render();
        break;
      case 'expand':
        state.settings.collapsed = false;
        saveStateSoon();
        render();
        break;
      case 'collapse':
        state.settings.collapsed = true;
        saveStateSoon();
        render();
        break;
      case 'hide':
        state.settings.hidden = true;
        saveStateSoon();
        render();
        break;
      case 'settings':
        ui.view = 'settings';
        render();
        break;
      case 'back-main':
        ui.view = 'main';
        ui.calibration = null;
        render();
        break;
      case 'calibrate':
        openCalibration();
        break;
      case 'quick-switch-gpt6':
        switchComposerModel({ key: 'gpt6', label: '6 Pro', radioLabel: '最新', composerLabel: '6 Pro' });
        break;
      case 'quick-switch-sol':
        switchComposerModel({ key: 'solpro', label: '5.6 Pro', radioLabel: 'GPT-5.6 Sol', composerLabel: '5.6 Pro' });
        break;
      case 'logs':
        ui.view = 'logs';
        render();
        break;
      case 'manual-add-gpt6':
        manualAdd('gpt6');
        break;
      case 'manual-remove-gpt6':
        manualRemove('gpt6');
        break;
      case 'manual-add-sol':
        manualAdd('solpro');
        break;
      case 'manual-remove-sol':
        manualRemove('solpro');
        break;
      case 'apply-calibration':
        applyCalibration();
        break;
      case 'export':
        exportData();
        break;
      case 'import': {
        const input = shadow.querySelector('[data-role="import-file"]');
        input?.click();
        break;
      }
      case 'clear-day':
        clearCurrentDayWindow();
        break;
      case 'clear-all':
        clearAllData();
        break;
      case 'clear-logs':
        state.logs = [];
        saveStateSoon();
        render();
        break;
      case 'reset-size':
        resetPanelSize();
        break;
      case 'reset-position':
        state.settings.position = null;
        applyStoredPosition();
        saveStateSoon();
        showToast('面板位置已重置', 'success');
        break;
      default:
        break;
    }
  }

  const MODEL_SWITCH_TIMEOUT_MS = 1200;

  function modelSwitchText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isVisibleElement(element) {
    if (!element || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  function waitForModelElement(find, errorMessage) {
    const deadline = Date.now() + MODEL_SWITCH_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!isActiveUiOwner()) return reject(new Error('脚本界面已被新实例接管'));
        const element = find();
        if (element && isVisibleElement(element)) return resolve(element);
        if (Date.now() >= deadline) return reject(new Error(errorMessage));
        setTimeout(check, 40);
      };
      check();
    });
  }

  function findModelRadio(label) {
    return [...document.querySelectorAll('[role="menuitemradio"]')].find((radio) => {
      const text = modelSwitchText(radio.innerText || radio.getAttribute('aria-label'));
      const advancedView = radio.closest('[data-testid="composer-model-picker-slider-advanced-view"]');
      return text === label && advancedView?.getAttribute('data-active') === 'true';
    });
  }

  function dispatchModelPickerPointerDown(element) {
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
    }));
  }

  async function selectProCapability() {
    const control = await waitForModelElement(
      () => document.querySelector('[role="menuitem"][aria-label="能力"]'),
      '模型菜单中未找到能力档位',
    );
    const slider = () => control.querySelector('[role="slider"][aria-valuenow][aria-valuemax]');
    const max = Number(slider()?.getAttribute('aria-valuemax'));
    let current = Number(slider()?.getAttribute('aria-valuenow'));
    if (!Number.isInteger(max) || !Number.isInteger(current) || max < 1 || current < 0 || current > max)
      throw new Error('无法读取能力档位');
    while (current < max) {
      control.focus();
      control.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true,
      }));
      const previous = current;
      await waitForModelElement(
        () => Number(slider()?.getAttribute('aria-valuenow')) > previous ? control : null,
        '能力档位未切换到 Pro',
      );
      current = Number(slider()?.getAttribute('aria-valuenow'));
    }
  }

  async function switchComposerModel(target) {
    if (ui.modelSwitch) return;
    ui.modelSwitch = target.key;
    render();
    try {
      const composer = await waitForModelElement(
        () => document.querySelector('button.__composer-pill[aria-haspopup="menu"]'),
        '未找到编辑器模型按钮',
      );
      dispatchModelPickerPointerDown(composer);
      const chooseModel = await waitForModelElement(
        () => document.querySelector('[role="menuitem"][aria-label="选择模型"]'),
        '模型菜单中未找到“选择模型”',
      );
      chooseModel.click();
      const radio = await waitForModelElement(
        () => findModelRadio(target.radioLabel),
        `未找到可选模型“${target.radioLabel}”`,
      );
      radio.click();
      await selectProCapability();
      const composerInput = await waitForModelElement(
        () => document.querySelector('#prompt-textarea'),
        '未找到编辑器，无法关闭模型菜单',
      );
      dispatchModelPickerPointerDown(composerInput);
      await waitForModelElement(
        () => modelSwitchText(composer.innerText) === target.composerLabel && composer.getAttribute('aria-expanded') !== 'true' ? composer : null,
        `编辑器未确认显示“${target.composerLabel}”`,
      );
      showToast(`已切换到 ${target.label}`, 'success');
    } catch (error) {
      showToast(`切换到 ${target.label} 失败：${error?.message || '未知错误'}`, 'danger');
    } finally {
      ui.modelSwitch = '';
      render();
    }
  }

  function onUiChange(event) {
    if (event.target.matches('[data-size-slider]')) {
      setPanelScale(Number(event.target.value) / 100); saveStateNow(); return;
    }
    const setting = event.target.dataset.setting;
    if (setting) {
      const value = event.target.value;
      if (setting === 'plan' && ['pro100', 'pro200'].includes(value)) state.settings.plan = value;
      if (setting === 'dayWindow' && ['rolling24', 'localDay'].includes(value)) state.settings.dayWindow = value;
      if (setting === 'weekWindow' && ['rolling7', 'localWeek'].includes(value)) state.settings.weekWindow = value;
      if (setting === 'countingMode' && ['request-first', 'model-first'].includes(value)) state.settings.countingMode = value;
      saveStateSoon();
      render();
      return;
    }

    if (event.target.matches('[data-role="import-file"]')) {
      const file = event.target.files && event.target.files[0];
      if (file) importData(file);
    }
  }

  function onUiInput(event) {
    if (event.target.matches('[data-size-slider]')) { setPanelScale(Number(event.target.value) / 100); return; }
    const key = event.target.dataset.calibrationKey;
    if (!key || !ui.calibration) return;
    ui.calibration[key] = event.target.value;
  }

  function manualAdd(model) {
    addUsageRecord(model, {
      ts: Date.now(),
      source: 'manual',
      confidence: 'manual',
      eventKey: `manual:${cryptoRandomId()}`,
      rawModel: modelDisplayName(model),
    });
    addLog({
      ts: Date.now(),
      result: 'counted',
      reason: 'manual-plus-one',
      requestedModel: '',
      actualModel: modelDisplayName(model),
      confidence: 'manual',
      route: location.pathname,
      eventKey: `manual-log:${cryptoRandomId()}`,
    });
    showToast(`${modelDisplayName(model)} 手动 +1`, 'success');
  }

  function manualRemove(model) {
    const candidates = state.records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.model === model)
      .sort((a, b) => b.record.ts - a.record.ts);
    if (!candidates.length) {
      showToast(`没有可删除的 ${modelDisplayName(model)} 记录`, 'warning');
      return;
    }
    const removed = candidates[0];
    state.records.splice(removed.index, 1);
    const request = pendingById(removed.record.requestId);
    if (request) manualResolveRequest(request, 'ignore');
    addLog({
      ts: Date.now(),
      result: 'not-counted',
      reason: `manual-minus-one:${removed.record.source}`,
      requestedModel: removed.record.requestedModel,
      actualModel: removed.record.rawModel || modelDisplayName(model),
      confidence: 'manual',
      route: location.pathname,
      eventKey: `manual-minus:${cryptoRandomId()}`,
    });
    saveStateSoon();
    render();
    showToast(`${modelDisplayName(model)} 已删除最近 1 条`, 'neutral');
  }

  function parseNonNegativeInt(value, label) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > 5000) {
      throw new Error(`${label} 必须是 0–5000 的整数`);
    }
    return number;
  }

  function applyCalibration() {
    try {
      if (!ui.calibration) throw new Error('没有校准数据');
      const now = Date.now();
      const { dayStart, weekStart } = getBoundaries(now);
      const batchId = `calibration:${cryptoRandomId()}`;

      if (state.settings.plan === 'pro200') {
        const dayGpt6 = parseNonNegativeInt(ui.calibration.dayGpt6, '日窗 GPT-6');
        const daySol = parseNonNegativeInt(ui.calibration.daySol, '日窗 5.6');
        const weekGpt6 = parseNonNegativeInt(ui.calibration.weekGpt6, '周窗 GPT-6');
        if (weekGpt6 < dayGpt6) throw new Error('周窗 GPT-6 已用不能小于日窗 GPT-6 已用');
        if (weekGpt6 > dayGpt6 && dayStart - weekStart < 2000) {
          throw new Error('当前日窗与周窗起点相同；此时周 GPT-6 用量必须等于日 GPT-6 用量');
        }

        replaceDayWindowCount('gpt6', dayGpt6, dayStart, now, batchId);
        replaceDayWindowCount('solpro', daySol, dayStart, now, batchId);
        replaceWeekOutsideDayCount('gpt6', weekGpt6 - dayGpt6, weekStart, dayStart, batchId);
      } else {
        const weekGpt6 = parseNonNegativeInt(ui.calibration.weekGpt6, '周窗 GPT-6');
        const weekSol = parseNonNegativeInt(ui.calibration.weekSol, '周窗 5.6');
        replaceWholeWindowCount('gpt6', weekGpt6, weekStart, now, batchId);
        replaceWholeWindowCount('solpro', weekSol, weekStart, now, batchId);
      }

      for (const p of [...state.pending]) {
        const effectiveModel = (['gpt6','solpro'].includes(p.manualDecision) ? p.manualDecision : '')
          || classifyModel(p.actualModel, p.actualThinkingEffort).model || classifyModel(p.requestedModel, p.thinkingEffort).model;
        const cutoff = state.settings.plan === 'pro100' || effectiveModel === 'gpt6' ? weekStart : dayStart;
        if (p.startedAt >= cutoff) { ui.inFlight.delete(p.requestId); upsertPending({...p, manualDecision: 'ignore'}, 'ignored'); writeRequestJournal(pendingById(p.requestId)); }
      }
      addLog({
        ts: now,
        result: 'counted',
        reason: 'manual-calibration-applied',
        requestedModel: '',
        actualModel: '',
        confidence: 'manual',
        route: location.pathname,
        eventKey: batchId,
      });
      ui.view = 'main';
      ui.calibration = null;
      saveStateSoon();
      render();
      showToast('校准已应用', 'success');
    } catch (error) {
      showToast(error && error.message ? error.message : '校准失败', 'danger');
    }
  }

  function replaceDayWindowCount(model, target, dayStart, now, batchId) {
    state.records = state.records.filter((record) => !(record.model === model && record.ts >= dayStart));
    addSyntheticRecords(model, target, Math.max(dayStart + 1000, now - 1000), `${batchId}:day:${model}`);
  }

  function replaceWeekOutsideDayCount(model, targetOutsideDay, weekStart, dayStart, batchId) {
    state.records = state.records.filter((record) => !(
      record.model === model
      && record.ts >= weekStart
      && record.ts < dayStart
    ));

    if (targetOutsideDay <= 0) return;
    if (dayStart - weekStart < 2000) {
      throw new Error('当前日窗与周窗起点相同，无法写入“本周但不在今日”的记录；此时周用量应等于日用量');
    }
    const ts = Math.floor(weekStart + (dayStart - weekStart) / 2);
    addSyntheticRecords(model, targetOutsideDay, ts, `${batchId}:week-outside-day:${model}`);
  }

  function replaceWholeWindowCount(model, target, windowStart, now, batchId) {
    state.records = state.records.filter((record) => !(record.model === model && record.ts >= windowStart));
    addSyntheticRecords(model, target, Math.max(windowStart + 1000, now - 1000), `${batchId}:week:${model}`);
  }

  function addSyntheticRecords(model, count, baseTs, prefix) {
    for (let index = 0; index < count; index += 1) {
      state.records.push(normalizeRecord({
        id: cryptoRandomId(),
        ts: Math.min(Date.now(), baseTs),
        model,
        source: 'calibration',
        confidence: 'manual',
        eventKey: `${prefix}:${index}`,
        assistantId: '',
        conversationId: '',
        requestedModel: '',
        rawModel: modelDisplayName(model),
        route: location.pathname,
      }));
    }
  }

  function clearCurrentDayWindow() {
    const { dayStart } = getBoundaries();
    const count = state.records.filter((record) => record.ts >= dayStart).length;
    if (!count) {
      showToast('当前日窗没有记录', 'neutral');
      return;
    }
    if (!window.confirm(`确定删除当前日窗内的 ${count} 条记录吗？`)) return;
    state.records = state.records.filter((record) => record.ts < dayStart);
    for (const p of [...state.pending]) if (p.startedAt >= dayStart) manualResolveRequest(p, 'ignore');
    saveStateSoon();
    render();
    showToast('当前日窗已清空', 'success');
  }

  function clearAllData() {
    if (!window.confirm('确定清空所有本机用量记录和识别日志吗？此操作不可撤销。')) return;
    state.records = [];
    state.pending = [];
    clearRequestJournals();
    // Progress/final events are ignored unless a matching request still exists.
    // Clearing both ledgers therefore prevents re-adds without retaining personal metadata.
    ui.inFlight.clear();
    state.logs = [];
    saveStateSoon();
    render();
    showToast('所有本机数据已清空', 'success');
  }

  function exportData() {
    const payload = {
      app: APP_ID,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      note: 'Only local timestamps, model identifiers, IDs, and diagnostics. No prompt or response body is stored.',
      state,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `chatgpt-pro-usage-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('JSON 已导出', 'success');
  }

  async function importData(file) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const imported = parsed && parsed.state ? parsed.state : parsed;
      if (!imported || !Array.isArray(imported.records)) throw new Error('文件中没有有效 records');
      if (!window.confirm('导入会替换当前本机记录和设置，确定继续吗？')) return;

      state = {
        schemaVersion: 5,
        records: imported.records.map(normalizeRecord).filter(Boolean),
        pending: Array.isArray(imported.pending) ? imported.pending.map(normalizePending).filter(Boolean) : [],
        logs: Array.isArray(imported.logs) ? imported.logs.map(normalizeLog).filter(Boolean).slice(-MAX_LOGS) : [],
        settings: normalizeSettings(imported.settings || DEFAULT_SETTINGS),
      };
      clearRequestJournals();
      for (const p of state.pending) writeRequestJournal(p);
      pruneOldData();
      saveStateNow();
      ui.view = 'main';
      applyStoredPosition();
      render();
      showToast('JSON 已导入', 'success');
    } catch (error) {
      showToast(`导入失败：${error && error.message ? error.message : '格式错误'}`, 'danger');
    }
  }

  function showToast(text, kind = 'neutral') {
    ui.toast = { text: String(text), kind };
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      ui.toast = null;
      render();
    }, 2800);
    render();
  }

  function planLabel() {
    return state.settings.plan === 'pro100' ? 'Pro $100' : 'Pro $200';
  }

  function windowModeLabel() {
    const day = state.settings.dayWindow === 'rolling24' ? '滚动24h' : '本地自然日';
    const week = state.settings.weekWindow === 'rolling7' ? '滚动7d' : '周一至周日';
    return `${day} / ${week}`;
  }

  function formatCount(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)).toLocaleString('zh-CN') : '0';
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return '—';
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
  }

  function formatFuture(timestamp) {
    if (!timestamp) return '暂无可释放记录';
    const now = Date.now();
    const delta = timestamp - now;
    const absolute = new Intl.DateTimeFormat('zh-CN', {
      weekday: delta > DAY_MS ? 'short' : undefined,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(timestamp));
    if (delta <= 0) return `现在（${absolute}）`;
    const minutes = Math.ceil(delta / 60_000);
    if (minutes < 60) return `${minutes} 分钟后（${absolute}）`;
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    if (hours < 48) return `${hours}小时${remainder ? `${remainder}分` : ''}后（${absolute}）`;
    return absolute;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
