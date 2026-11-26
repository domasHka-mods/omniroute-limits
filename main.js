import { View, div } from "gpui-kit";
import { h_flex, v_flex, Input, InputState } from "gpui-base";
import {
  theme,
  shared,
  setShared,
  openOverlay,
  closeOverlay,
  props,
  checking,
  window,
  readTextFile,
  writeTextFile,
  home,
  appHome,
  exec,
} from "herdr";

const DEFAULT_URL = "http://203.0.113.2:20129";
const SHARED_KEY = "omniroute.limits";
const SHARED_CFG = "omniroute.config";

function cfgPath() {
  const sep = appHome().includes("\\") ? "\\" : "/";
  return `${appHome()}${sep}data${sep}omniroute-limits.json`;
}

async function loadConfig() {
  const cached = shared(SHARED_CFG);
  if (cached?.url) return cached;
  try {
    const raw = await readTextFile(cfgPath());
    const parsed = JSON.parse(raw);
    const cfg = {
      url: (parsed?.url || DEFAULT_URL).replace(/\/+$/, ""),
      token: parsed?.token || "",
      selectedModels: Array.isArray(parsed?.selectedModels) ? parsed.selectedModels : [],
    };
    setShared(SHARED_CFG, cfg);
    return cfg;
  } catch {
    return { url: DEFAULT_URL, token: "", selectedModels: [] };
  }
}

async function saveConfig(url, token, selectedModels) {
  const prev = await loadConfig();
  const cfg = {
    url: (url ?? prev.url ?? DEFAULT_URL).trim().replace(/\/+$/, "") || DEFAULT_URL,
    token: (token ?? prev.token ?? "").trim(),
    selectedModels: Array.isArray(selectedModels) ? selectedModels : prev.selectedModels || [],
  };
  setShared(SHARED_CFG, cfg);
  await writeTextFile(cfgPath(), JSON.stringify(cfg, null, 2)).catch(() => {});
  return cfg;
}

// shortcut: strips // and /* */ comments and trailing commas; fails over to [] on exotic JSONC.
function parseJsonc(text) {
  const clean = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(clean);
}

async function loadUserModels() {
  try {
    const sep = home().includes("\\") ? "\\" : "/";
    const raw = await readTextFile(`${home()}${sep}.config${sep}opencode${sep}opencode.jsonc`);
    const cfg = parseJsonc(raw);
    const models = cfg?.provider?.omniroute?.models;
    if (!models || typeof models !== "object") return [];
    return Object.entries(models).map(([id, m]) => ({
      id,
      name: m?.name || id,
    }));
  } catch {
    return [];
  }
}

async function apiGet(baseUrl, path, token) {
  if (token && token.includes("=")) {
    const script = `
      (async () => {
        const [url, cookie] = process.argv.slice(1);
        const res = await fetch(url, { headers: { Cookie: cookie, Connection: "close" } });
        const text = await res.text();
        if (res.status === 401 || res.status === 403) { console.error("AUTH:" + res.status); process.exitCode = 2; return; }
        if (!res.ok) { console.error("HTTP " + res.status + ": " + text.slice(0, 200)); process.exitCode = 1; return; }
        console.log(text);
      })();
    `;
    const r = await exec("node", ["-e", script, `${baseUrl}${path}`, token]);
    if (r.code === 2) {
      const err = new Error("auth");
      err.code = "AUTH";
      throw err;
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Request failed").trim());
    return JSON.parse(r.stdout);
  }
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error("auth");
    err.code = "AUTH";
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loginWithPassword(baseUrl, password) {
  const script = `
    (async () => {
      const [url, password] = process.argv.slice(1);
      const res = await fetch(url + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connection": "close" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
      const joined = cookies.join("; ");
      if (!res.ok) { console.error(JSON.stringify({ status: res.status, cookies, body: data })); process.exitCode = 1; return; }
      const m = joined.match(/auth_token=[^;]+/) || joined.match(/[^=\\s;]+=[^;]+/);
      if (m) { console.log(m[0]); return; }
      if (data?.token) { console.log(data.token); return; }
      console.error(JSON.stringify({ status: res.status, cookies, body: data })); process.exitCode = 1;
    })();
  `;
  const r = await exec("node", ["-e", script, baseUrl, password]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Login failed").trim());
  const token = (r.stdout || "").trim();
  if (!token) throw new Error("Empty token");
  return token;
}

function openBrowser(url) {
  const p = window()?.platform;
  if (p === "windows") return exec("cmd", ["/c", "start", "", url]);
  if (p === "macos") return exec("open", [url]);
  return exec("xdg-open", [url]);
}

const PREFIX_ALIASES = {
  agy: ["antigravity", "agy"],
  gpt: ["codex", "openai", "gpt"],
  claude: ["claude", "anthropic"],
  gemini: ["gemini", "google"],
};

function matchProvider(modelId, providers) {
  const lower = modelId.toLowerCase();
  const prefix = lower.includes("/") ? lower.split("/")[0] : lower.split("-")[0];
  const aliases = PREFIX_ALIASES[prefix] || [prefix];
  return providers.find((p) => {
    const prov = (p.provider || "").toLowerCase();
    const name = (p.name || "").toLowerCase();
    return aliases.some((a) => prov.includes(a) || name.includes(a)) || (prov && lower.includes(prov));
  });
}

function formatReset(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h ${mins % 60}m` : `${Math.floor(hrs / 24)}d`;
}

export default class OmnirouteLimits extends View {
  init(_props, cx) {
    const p = props();
    this.isPopup = Boolean(p?.popup || p?.overlay);
    this.showSettings = false;
    this.saving = false;

    if (checking()) return;

    if (this.isPopup) {
      this.urlInput = InputState.new({ placeholder: DEFAULT_URL, value: DEFAULT_URL });
      this.passInput = InputState.new({ placeholder: "Dashboard password", value: "" });
      this.passInput.set_masked(true);
      this.tokenInput = InputState.new({ placeholder: "Bearer token (or cookie)", value: "" });
      this.tokenInput.set_masked(true);
      cx.spawn(async (cx) => {
        const cfg = await loadConfig();
        this.urlInput?.set_value(cfg.url);
        this.tokenInput?.set_value(cfg.token);
        this.showSettings = !cfg.token;
        if (!shared(SHARED_KEY) && cfg.token) this.refresh(cx);
        cx.notify();
      });
    } else {
      cx.timer.every(60000, (cx) => {
        if (window()?.visible !== false) this.refresh(cx);
      });
      this.refresh(cx);
    }
  }

  close() {
    this.urlInput?.release();
    this.passInput?.release();
    this.tokenInput?.release();
  }

  refresh(cx) {
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const { url, token, selectedModels } = await loadConfig();
      if (!token) {
        this.loading = false;
        setShared(SHARED_KEY, { status: "auth", updatedAt: Date.now() });
        cx.notify();
        return;
      }
      try {
        const [quota, providerLimits, analytics, rateLimits, userModels] = await Promise.all([
          apiGet(url, "/api/usage/quota", token),
          apiGet(url, "/api/usage/provider-limits", token).catch(() => ({})),
          apiGet(url, "/api/usage/analytics?range=1d", token).catch(() => ({})),
          apiGet(url, "/api/rate-limits", token).catch(() => ({})),
          loadUserModels(),
        ]);

        const providers = Array.isArray(quota?.providers) ? quota.providers : [];
        const caches = providerLimits?.caches || {};
        const byModel = Array.isArray(analytics?.byModel) ? analytics.byModel : [];
        const limits = Array.isArray(rateLimits?.limits) ? rateLimits.limits : [];
        const budget = analytics?.budget || null;

        // Enrich each provider connection with its cached quotas from /api/usage/provider-limits
        const enrichedProviders = providers.map((p) => {
          const cache = caches[p.connectionId];
          const quotas = cache?.quotas || {};
          const quotaGroups = Array.isArray(cache?.quotaGroups) ? cache.quotaGroups : [];
          const entries = Object.values(quotas).filter((q) => q && typeof q === "object");
          const pcts = entries
            .map((q) => q.remainingPercentage ?? q.remaining)
            .filter((v) => typeof v === "number");
          const minPct = pcts.length > 0 ? Math.min(...pcts) : p.percentRemaining;
          const resets = entries.map((q) => q.resetAt).filter(Boolean).sort();
          return {
            ...p,
            plan: cache?.plan || null,
            quotas,
            quotaGroups,
            percentRemaining: minPct ?? null,
            resetAt: resets[0] || p.resetAt || null,
          };
        });

        const allModels =
          userModels.length > 0
            ? userModels
            : byModel.map((m) => ({ id: m.model || m.id || "unknown", name: m.model || m.id || "unknown" }));

        const targetModels =
          selectedModels && selectedModels.length > 0
            ? allModels.filter((m) => selectedModels.includes(m.id))
            : allModels;

        const modelRows = targetModels.map((m) => {
          const bare = m.id.includes("/") ? m.id.split("/").slice(1).join("/") : m.id;
          const prefix = m.id.includes("/") ? m.id.split("/")[0].toLowerCase() : m.id.split("-")[0].toLowerCase();
          const aliases = PREFIX_ALIASES[prefix] || [prefix];

          // Collect per-model quota across all matching provider connections
          const matchingConns = enrichedProviders.filter((p) => {
            const prov = (p.provider || "").toLowerCase();
            return aliases.some((a) => prov.includes(a)) || (prov && m.id.toLowerCase().includes(prov));
          });

          const winPct = (w) => {
            if (!w || typeof w !== "object") return null;
            if (typeof w.remainingPercentage === "number") return w.remainingPercentage;
            if (typeof w.remaining === "number") return w.remaining;
            if (typeof w.total === "number" && w.total > 0) return ((w.total - (w.used ?? 0)) / w.total) * 100;
            return null;
          };

          const modelPcts = [];
          const sPcts = [];
          const wPcts = [];
          const modelResets = [];
          for (const c of matchingConns) {
            const grp = (c.quotaGroups || []).find(
              (g) => Array.isArray(g.models) && (g.models.includes(bare) || g.models.includes(m.id))
            );
            const sq = grp?.windows?.session || c.quotas?.session;
            const wq = grp?.windows?.weekly || c.quotas?.weekly;
            const sVal = winPct(sq);
            const wVal = winPct(wq);
            if (sVal !== null || wVal !== null) {
              if (sVal !== null) {
                sPcts.push(sVal);
                if (sq.resetAt) modelResets.push(sq.resetAt);
              }
              if (wVal !== null) {
                wPcts.push(wVal);
                if (wq.resetAt) modelResets.push(wq.resetAt);
              }
            } else {
              const q = c.quotas?.[bare] || c.quotas?.[m.id];
              const qVal = winPct(q);
              if (qVal !== null) {
                modelPcts.push(qVal);
                if (q.resetAt) modelResets.push(q.resetAt);
              } else if (typeof c.percentRemaining === "number") {
                modelPcts.push(c.percentRemaining);
                if (c.resetAt) modelResets.push(c.resetAt);
              }
            }
          }

          const sumOf = (arr) => (arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0)) : null);
          const sSum = sumOf(sPcts);
          const sMax = sPcts.length > 0 ? sPcts.length * 100 : null;
          const wSum = sumOf(wPcts);
          const wMax = wPcts.length > 0 ? wPcts.length * 100 : null;
          const sumPct = sumOf(modelPcts) ?? (wSum ?? sSum);
          const maxPct = modelPcts.length > 0 ? modelPcts.length * 100 : (wMax ?? sMax);
          const avgPct = sumPct !== null && maxPct ? (sumPct / maxPct) * 100 : null;
          modelResets.sort();

          const usage = byModel.find((u) => u.model === m.id || u.id === m.id || u.model === bare);
          return {
            id: m.id,
            name: m.name,
            requests: usage?.requests ?? usage?.requestCount ?? 0,
            cost: usage?.cost ?? usage?.totalCost ?? 0,
            provider: matchingConns[0]?.provider || null,
            accounts: Math.max(modelPcts.length, sPcts.length, wPcts.length),
            sumPct,
            maxPct,
            sSum,
            sMax,
            wSum,
            wMax,
            percentRemaining: avgPct,
            resetAt: modelResets[0] || null,
          };
        });

        const withQuota = modelRows.filter((r) => typeof r.sumPct === "number");
        const totalRem =
          withQuota.length > 0
            ? withQuota.reduce((a, r) => a + r.sumPct, 0)
            : Math.round(enrichedProviders.reduce((a, p) => a + (p.percentRemaining ?? 0), 0));
        const totalMax =
          withQuota.length > 0
            ? withQuota.reduce((a, r) => a + r.maxPct, 0)
            : enrichedProviders.filter((p) => typeof p.percentRemaining === "number").length * 100;
        const minPercent = totalMax > 0 ? Math.round((totalRem / totalMax) * 100) : null;

        this.loading = false;
        setShared(SHARED_KEY, {
          status: "ok",
          minPercent,
          totalRem: totalMax > 0 ? totalRem : null,
          totalMax: totalMax > 0 ? totalMax : null,
          budget,
          allModels,
          modelRows,
          providers: enrichedProviders.filter((p) => typeof p.percentRemaining === "number"),
          limits,
          updatedAt: Date.now(),
        });
      } catch (err) {
        this.loading = false;
        setShared(SHARED_KEY, {
          status: err?.code === "AUTH" ? "auth" : "offline",
          error: err?.message || "error",
          updatedAt: Date.now(),
        });
      }
      cx.notify();
    });
  }

  login(cx) {
    const url = (this.urlInput?.value() || DEFAULT_URL).trim().replace(/\/+$/, "");
    const password = this.passInput?.value() || "";
    if (!password) return;
    this.loading = true;
    this.authError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const token = await loginWithPassword(url || DEFAULT_URL, password);
        await saveConfig(url, token);
        this.tokenInput?.set_value(token);
        this.passInput?.set_value("");
        this.showSettings = false;
        this.refresh(cx);
      } catch (err) {
        this.loading = false;
        this.authError = err?.message || "Login failed";
        cx.notify();
      }
    });
  }

  saveSettings(cx) {
    const url = this.urlInput?.value() || DEFAULT_URL;
    const token = this.tokenInput?.value() || "";
    cx.spawn(async (cx) => {
      const cfg = await saveConfig(url, token);
      this.showSettings = !cfg.token;
      this.refresh(cx);
      cx.notify();
    });
  }

  toggleModel(id, cx) {
    cx.spawn(async (cx) => {
      const cfg = await loadConfig();
      const cur = cfg.selectedModels || [];
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      await saveConfig(null, null, next);
      this.refresh(cx);
    });
  }

  clearModels(cx) {
    cx.spawn(async (cx) => {
      await saveConfig(null, null, []);
      this.refresh(cx);
    });
  }

  renderStatus(t, data) {
    let label = "OmniRoute: ...";
    let color = t.dim;

    if (!data || data.status === "auth") {
      label = "OmniRoute: auth";
      color = data?.status === "auth" ? t.blocked : t.dim;
    } else if (data.status === "offline") {
      label = "OmniRoute: offline";
      color = t.dim;
    } else {
      const pct =
        data.totalRem !== null && data.totalMax !== null
          ? `${data.totalRem}/${data.totalMax}%`
          : data.minPercent !== null
            ? `${data.minPercent}%`
            : "ok";
      const rem = data.budget?.remaining;
      const budgetStr = typeof rem === "number" ? ` · $${rem.toFixed(2)}` : "";
      label = `OmniRoute: ${pct}${budgetStr}`;
      color =
        data.minPercent !== null && data.minPercent < 20
          ? t.blocked
          : data.minPercent !== null && data.minPercent < 50
            ? t.done
            : t.muted;
    }

    return h_flex()
      .id("omniroute-status")
      .h_full()
      .px(12)
      .items_center()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(11.8)
      .text_color(color)
      .hover((s) => s.bg(t.hover))
      .on_click(() =>
        openOverlay({
          mod: "omniroute-limits",
          kind: "dialog",
          props: { popup: true },
          width: 440,
          height: 400,
        })
      )
      .child(label);
  }

  renderPopup(t, data, _cx) {
    const btn = (id, text, onClick, primary = false) =>
      div()
        .id(id)
        .px(8)
        .py(4)
        .rounded(5)
        .text_size(11.5)
        .bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground)
        .hover((s) => s.bg(primary ? t.accent : t.hover))
        .on_click((_e, clickCx) => onClick(clickCx))
        .child(text);

    const rows = data?.modelRows || [];
    const providers = data?.providers || [];

    return v_flex()
      .size_full()
      .p(12)
      .gap(10)
      .bg(t.popover)
      .text_size(12)
      .text_color(t.foreground)
      .child(
        h_flex()
          .justify_between()
          .items_center()
          .child(div().font_semibold().text_size(13).child("OmniRoute Limits"))
          .child(
            h_flex()
              .gap(6)
              .child(btn("refresh", this.loading ? "..." : "Refresh", (c) => this.refresh(c)))
              .child(
                btn("picker", this.showPicker ? "Done" : "Models", (c) => {
                  this.showPicker = !this.showPicker;
                  if (this.showPicker) this.showSettings = false;
                  c.notify();
                })
              )
              .child(
                btn("settings", this.showSettings ? "Back" : "Auth", (c) => {
                  this.showSettings = !this.showSettings;
                  if (this.showSettings) this.showPicker = false;
                  c.notify();
                })
              )
              .child(btn("close", "×", () => closeOverlay(props()?.overlay)))
          )
      )
      .when(this.showSettings, (el) =>
        el.child(
          v_flex()
            .gap(8)
            .p(10)
            .rounded(6)
            .bg(t.surface)
            .border(1)
            .border_color(t.border)
            .child(
              h_flex()
                .justify_between()
                .items_center()
                .child(div().text_size(11).text_color(t.muted).child("OmniRoute URL"))
                .child(
                  btn("open-web", "Open OmniRoute", () => {
                    const u = (this.urlInput?.value() || DEFAULT_URL).trim().replace(/\/+$/, "");
                    openBrowser(u || DEFAULT_URL);
                  })
                )
            )
            .child(
              div()
                .px(8)
                .py(4)
                .rounded(4)
                .bg(t.background)
                .border(1)
                .border_color(t.input)
                .child(Input.new(this.urlInput))
            )
            .child(div().text_size(11).text_color(t.muted).child("Dashboard Password (auto-login)"))
            .child(
              h_flex()
                .gap(6)
                .child(
                  div()
                    .flex_1()
                    .px(8)
                    .py(4)
                    .rounded(4)
                    .bg(t.background)
                    .border(1)
                    .border_color(t.input)
                    .child(Input.new(this.passInput))
                )
                .child(btn("login", this.loading ? "..." : "Login", (c) => this.login(c), true))
            )
            .child(div().text_size(11).text_color(t.muted).child("Or Bearer Token / Cookie"))
            .child(
              div()
                .px(8)
                .py(4)
                .rounded(4)
                .bg(t.background)
                .border(1)
                .border_color(t.input)
                .child(Input.new(this.tokenInput))
            )
            .child(
              h_flex()
                .gap(8)
                .justify_between()
                .items_center()
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11)
                    .text_color(this.authError || data?.status === "auth" ? t.blocked : data?.status === "ok" ? t.done : t.muted)
                    .child(
                      this.loading
                        ? "Connecting..."
                        : this.authError
                          ? this.authError
                          : data?.status === "ok"
                            ? "Connected"
                            : data?.status === "auth"
                              ? "Auth required / invalid token"
                              : data?.status === "offline"
                                ? `Error: ${data.error || "unreachable"}`
                                : ""
                    )
                )
                .when(Boolean(this.authError || data?.status === "offline"), (el) =>
                  el.child(
                    btn("copy-err", this.copied ? "Copied" : "Copy", (c) => {
                      c.write_to_clipboard(this.authError || data?.error || "");
                      this.copied = true;
                      c.notify();
                    })
                  )
                )
                .child(btn("save", this.loading ? "..." : "Save Token", (c) => this.saveSettings(c)))
            )
        )
      )
      .when(this.showPicker, (el) => {
        const all = data?.allModels || [];
        const sel = shared(SHARED_CFG)?.selectedModels || [];
        return el.child(
          v_flex()
            .flex_1()
            .gap(6)
            .overflow_y_scrollbar()
            .child(
              h_flex()
                .justify_between()
                .items_center()
                .child(div().text_size(11).text_color(t.muted).child(sel.length ? `Selected: ${sel.length}` : "Showing all (click to filter)"))
                .when(sel.length > 0, (h) => h.child(btn("clear-models", "Show All", (c) => this.clearModels(c))))
            )
            .children(
              all.map((m, i) => {
                const on = sel.includes(m.id);
                return h_flex()
                  .id(`pick-${i}`)
                  .gap(8)
                  .items_center()
                  .px(8)
                  .py(5)
                  .rounded(5)
                  .bg(on ? t.selected : t.surface)
                  .hover((s) => s.bg(t.hover))
                  .on_click((_e, c) => this.toggleModel(m.id, c))
                  .child(div().text_color(on ? t.accent : t.dim).child(on ? "[x]" : "[ ]"))
                  .child(div().flex_1().truncate().child(m.name));
              })
            )
        );
      })
      .when(!this.showSettings && !this.showPicker, (el) =>
        el.child(
          v_flex()
            .flex_1()
            .gap(6)
            .overflow_y_scrollbar()
            .when(this.loading, (c) =>
              c.child(div().text_color(t.muted).child("Connecting to OmniRoute..."))
            )
            .when(!this.loading && data?.status === "auth", (c) =>
              c.child(div().text_color(t.blocked).child("Authentication failed (401/403). Click Auth to check token."))
            )
            .when(!this.loading && data?.status === "offline", (c) =>
              c.child(div().text_color(t.blocked).child(`Offline: ${data.error || "unreachable"}`))
            )
            .when(!this.loading && data?.status === "ok" && rows.length === 0 && providers.length === 0, (c) =>
              c.child(div().text_color(t.muted).child("Connected. No active models or provider quotas returned."))
            )
            .when(typeof data?.budget?.limit === "number", (c) =>
              c.child(
                h_flex()
                  .justify_between()
                  .p(8)
                  .rounded(6)
                  .bg(t.surface)
                  .child(div().text_color(t.muted).child("Budget remaining"))
                  .child(
                    div()
                      .font_semibold()
                      .child(`$${Number(data.budget.remaining ?? 0).toFixed(2)} / $${Number(data.budget.limit).toFixed(2)}`)
                  )
              )
            )
            .when(rows.length > 0, (c) =>
              c.children(
                rows.map((r, i) => {
                  const lines = [];
                  if (r.sSum !== null) lines.push(`5h: ${r.sSum}/${r.sMax}%`);
                  if (r.wSum !== null) lines.push(`7d: ${r.wSum}/${r.wMax}%`);
                  if (lines.length === 0) {
                    lines.push(r.sumPct !== null && r.maxPct !== null ? `${r.sumPct}/${r.maxPct}%` : "—");
                  }
                  const reset = formatReset(r.resetAt);
                  const meta = [
                    r.provider,
                    r.requests ? `${r.requests} req` : null,
                    r.cost ? `$${Number(r.cost).toFixed(3)}` : null,
                    reset ? `reset ${reset}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const pctColor =
                    r.percentRemaining !== null && r.percentRemaining < 20
                      ? t.blocked
                      : r.percentRemaining !== null && r.percentRemaining < 50
                        ? t.done
                        : t.foreground;
                  return h_flex()
                    .id(`m-${i}`)
                    .justify_between()
                    .items_center()
                    .px(8)
                    .py(6)
                    .rounded(5)
                    .bg(t.surface)
                    .child(
                      v_flex()
                        .flex_1()
                        .min_w(0)
                        .gap(2)
                        .child(div().truncate().child(r.name))
                        .when(Boolean(meta), (m) => m.child(div().text_size(10.5).text_color(t.dim).child(meta)))
                    )
                    .child(
                      v_flex()
                        .items_end()
                        .gap(2)
                        .font_semibold()
                        .text_color(pctColor)
                        .children(lines.map((l) => div().child(l)))
                    );
                })
              )
            )
            .when(providers.length > 0, (c) =>
              c
                .child(div().pt(4).text_size(11).text_color(t.dim).child("Providers"))
                .children(
                  providers.map((p, i) => {
                    const winPct = (w) => {
                      if (!w || typeof w !== "object") return null;
                      if (typeof w.remainingPercentage === "number") return w.remainingPercentage;
                      if (typeof w.remaining === "number") return w.remaining;
                      if (typeof w.total === "number" && w.total > 0) return ((w.total - (w.used ?? 0)) / w.total) * 100;
                      return null;
                    };
                    const grpSessions = (p.quotaGroups || []).map((g) => winPct(g.windows?.session)).filter((v) => v !== null);
                    const grpWeeklies = (p.quotaGroups || []).map((g) => winPct(g.windows?.weekly)).filter((v) => v !== null);
                    const sVal = grpSessions.length > 0 ? Math.min(...grpSessions) : winPct(p.quotas?.session);
                    const wVal = grpWeeklies.length > 0 ? Math.min(...grpWeeklies) : winPct(p.quotas?.weekly);
                    const lines = [];
                    if (typeof sVal === "number") lines.push(`5h: ${Math.round(sVal)}%`);
                    if (typeof wVal === "number") lines.push(`7d: ${Math.round(wVal)}%`);
                    if (lines.length === 0) lines.push(`${Math.round(p.percentRemaining ?? 0)}%`);
                    const sub = [p.provider, p.plan].filter(Boolean).join(" · ");
                    return h_flex()
                      .id(`p-${i}`)
                      .justify_between()
                      .items_center()
                      .px(8)
                      .py(6)
                      .rounded(5)
                      .bg(t.surface)
                      .child(
                        v_flex()
                          .flex_1()
                          .min_w(0)
                          .gap(2)
                          .child(div().truncate().child(p.name || p.provider))
                          .when(Boolean(sub), (s) => s.child(div().text_size(10.5).text_color(t.dim).child(sub)))
                      )
                      .child(
                        v_flex()
                          .items_end()
                          .gap(2)
                          .font_semibold()
                          .children(lines.map((l) => div().child(l)))
                      );
                  })
                )
            )
        )
      );
  }

  render(cx) {
    const t = theme();
    const data = shared(SHARED_KEY);
    return this.isPopup ? this.renderPopup(t, data, cx) : this.renderStatus(t, data);
  }
}
