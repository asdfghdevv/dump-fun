(() => {
  "use strict";

  const DS = "https://api.dexscreener.com";
  const ROOT = document.currentScript ? new URL(".", document.currentScript.src).href : "";
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const GTA_VI_NIGHT = Date.parse("2026-11-19T05:00:00Z");
  const REFRESH_MS = 20_000;
  const MAX_COINS = 60;
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const NSFW = /(tits?|boob|porn|nsfw|nude|naked|sex|cum|cock|dick|pussy|anal|milf|hentai|onlyfans|rape|nigg|fag|retard|hitler|nazi)/i;

  const $ = (sel) => document.querySelector(sel);
  const list = $("#df-list");
  const detail = $("#df-detail");
  const status = $("#df-status");
  const toast = $("#df-toast");

  const state = { coins: [], view: [], tab: "trending", query: "", selected: -1, openMint: "", searching: false };

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function safeImage(url) {
    return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : "";
  }

  function compactUsd(value) {
    if (!(value > 0)) return "—";
    return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
  }

  function priceUsd(value) {
    if (!(value > 0)) return "—";
    if (value >= 1) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    if (value >= 0.001) return `$${value.toPrecision(4)}`;
    const zeros = -Math.floor(Math.log10(value)) - 1;
    return `$${value.toFixed(Math.min(12, zeros + 3))}`;
  }

  function pct(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return '<span class="df-rank">—</span>';
    const cls = value >= 0 ? "up" : "down";
    return `<span class="${cls}">${value >= 0 ? "+" : ""}${value.toFixed(1)}%</span>`;
  }

  function shortMint(mint) {
    return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  }

  function avatar(coin, size) {
    const src = safeImage(coin.icon);
    return src
      ? `<img src="${esc(src)}" alt="" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" />`
      : `<span class="df-ph" aria-hidden="true"></span>`;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
    }, 2400);
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function isPumpMint(address) {
    return typeof address === "string" && BASE58.test(address) && address.endsWith("pump");
  }

  function toCoin(pair) {
    const base = pair.baseToken || {};
    return {
      mint: base.address,
      symbol: (base.symbol || "?").slice(0, 16),
      name: (base.name || "").slice(0, 40),
      icon: pair.info?.imageUrl || "",
      priceUsd: Number(pair.priceUsd) || 0,
      change: typeof pair.priceChange?.h24 === "number" ? pair.priceChange.h24 : null,
      volume: Number(pair.volume?.h24) || 0,
      mcap: Number(pair.marketCap ?? pair.fdv) || 0,
      liquidity: Number(pair.liquidity?.usd) || 0,
      pair: pair.pairAddress,
      dex: pair.dexId || "",
      created: Number(pair.pairCreatedAt) || 0,
      url: typeof pair.url === "string" ? pair.url : "",
    };
  }

  function bestPairs(pairs) {
    const best = new Map();
    for (const pair of pairs || []) {
      if (pair?.chainId !== "solana" || !isPumpMint(pair.baseToken?.address)) continue;
      const current = best.get(pair.baseToken.address);
      if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(pair.baseToken.address, pair);
    }
    return [...best.values()]
      .map(toCoin)
      .filter((coin) => coin.priceUsd > 0 && BASE58.test(coin.pair || "") && !NSFW.test(`${coin.symbol} ${coin.name}`));
  }

  async function fetchTrending() {
    const feeds = await Promise.allSettled([
      getJson(`${DS}/token-boosts/top/v1`),
      getJson(`${DS}/token-boosts/latest/v1`),
      getJson(`${DS}/token-profiles/latest/v1`),
    ]);
    const mints = [];
    for (const feed of feeds) {
      if (feed.status !== "fulfilled" || !Array.isArray(feed.value)) continue;
      for (const item of feed.value) {
        if (item?.chainId === "solana" && isPumpMint(item.tokenAddress) && !mints.includes(item.tokenAddress)) mints.push(item.tokenAddress);
      }
    }
    const chunks = [];
    for (let i = 0; i < Math.min(mints.length, MAX_COINS); i += 30) chunks.push(mints.slice(i, i + 30));
    const results = await Promise.allSettled(chunks.map((chunk) => getJson(`${DS}/tokens/v1/solana/${chunk.join(",")}`)));
    return bestPairs(results.flatMap((r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : [])));
  }

  async function fetchSearch(query) {
    if (isPumpMint(query)) {
      const pairs = await getJson(`${DS}/tokens/v1/solana/${query}`);
      return bestPairs(Array.isArray(pairs) ? pairs : []);
    }
    const data = await getJson(`${DS}/latest/dex/search?q=${encodeURIComponent(query)}`);
    return bestPairs(data?.pairs);
  }

  function sortCoins(coins) {
    const copy = [...coins];
    if (state.tab === "movers") copy.sort((a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity));
    else if (state.tab === "new") copy.sort((a, b) => b.created - a.created);
    else copy.sort((a, b) => b.volume - a.volume);
    return copy;
  }

  function renderList() {
    state.view = sortCoins(state.coins);
    if (!state.view.length) {
      list.innerHTML = `<p class="df-empty">${state.query ? "No pump.fun coins match that search." : "No live coins right now. Retrying…"}</p>`;
      return;
    }
    const selectedMint = state.view[state.selected]?.mint || state.openMint;
    state.selected = Math.max(0, state.view.findIndex((coin) => coin.mint === selectedMint));
    list.innerHTML = state.view
      .map(
        (coin, i) => `<button type="button" class="df-coin df-row" role="option" data-i="${i}" aria-selected="${i === state.selected}">
          <span class="df-rank">${String(i + 1).padStart(2, "0")}</span>
          <span class="df-name">${avatar(coin, 34)}<span><b>$${esc(coin.symbol)}</b><small>${esc(coin.name)}</small></span></span>
          <span>${priceUsd(coin.priceUsd)}</span>
          <span>${pct(coin.change)}</span>
          <span class="df-hide-sm">${compactUsd(coin.volume)}</span>
          <span>${compactUsd(coin.mcap)}</span>
        </button>`,
      )
      .join("");
  }

  function renderDetail(coin) {
    if (!coin) return;
    state.openMint = coin.mint;
    const chart = `https://dexscreener.com/solana/${coin.pair}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=dark&theme=dark&chartStyle=1&chartType=usd&interval=15`;
    detail.innerHTML = `
      <div class="df-dhead">
        ${avatar(coin, 56)}
        <div><h3>$${esc(coin.symbol)}</h3><p>${esc(coin.name)} · ${shortMint(coin.mint)}</p></div>
        <button type="button" class="df-close" data-act="close">Back</button>
      </div>
      <div class="df-stats">
        <div><span>Price</span><b>${priceUsd(coin.priceUsd)}</b></div>
        <div><span>Mcap</span><b>${compactUsd(coin.mcap)}</b></div>
        <div><span>24h</span><b>${pct(coin.change)}</b></div>
        <div><span>Volume</span><b>${compactUsd(coin.volume)}</b></div>
        <div><span>Liquidity</span><b>${compactUsd(coin.liquidity)}</b></div>
        <div><span>Venue</span><b>${esc(coin.dex || "—")}</b></div>
      </div>
      <div class="df-chart"><iframe title="$${esc(coin.symbol)} chart" src="${esc(chart)}" loading="lazy"></iframe></div>
      <div class="df-links">
        <a href="https://pump.fun/coin/${coin.mint}" target="_blank" rel="noreferrer">pump.fun ↗</a>
        <a href="https://dexscreener.com/solana/${coin.pair}" target="_blank" rel="noreferrer">Dexscreener ↗</a>
        <button type="button" data-act="copy">Copy CA</button>
      </div>
      <button type="button" class="df-btn df-btn-red df-trade" data-act="trade">Trade $${esc(coin.symbol)}</button>
      <div class="df-swap" id="df-swap"></div>`;
  }

  function select(index, open) {
    if (!state.view.length) return;
    state.selected = (index + state.view.length) % state.view.length;
    list.querySelectorAll(".df-coin").forEach((row, i) => row.setAttribute("aria-selected", String(i === state.selected)));
    const row = list.querySelector(`[data-i="${state.selected}"]`);
    row?.scrollIntoView({ block: "nearest" });
    if (open) {
      renderDetail(state.view[state.selected]);
      if (window.matchMedia("(max-width: 980px)").matches) detail.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  let jupiterLoad;
  function loadJupiter() {
    if (window.Jupiter) return Promise.resolve(window.Jupiter);
    jupiterLoad ||= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://plugin.jup.ag/plugin-v1.js";
      script.async = true;
      script.onload = () => (window.Jupiter ? resolve(window.Jupiter) : reject(new Error("Jupiter did not load")));
      script.onerror = () => reject(new Error("Jupiter did not load"));
      document.head.appendChild(script);
    });
    return jupiterLoad;
  }

  async function openTrade() {
    const coin = state.view.find((c) => c.mint === state.openMint) || state.view[state.selected];
    if (!coin) return;
    if (state.openMint !== coin.mint) renderDetail(coin);
    const target = $("#df-swap");
    if (!target) return;
    target.innerHTML = '<p class="df-empty">Loading the Jupiter swap…</p>';
    try {
      const jupiter = await loadJupiter();
      target.innerHTML = "";
      jupiter.init({
        displayMode: "integrated",
        integratedTargetId: "df-swap",
        formProps: { initialInputMint: SOL_MINT, initialOutputMint: coin.mint },
        containerStyles: { maxHeight: "560px", borderRadius: "18px" },
      });
      target.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch {
      target.innerHTML = `<p class="df-empty">The swap widget could not load. Trade on <a href="https://jup.ag/swap/SOL-${coin.mint}" target="_blank" rel="noreferrer">jup.ag</a> instead.</p>`;
    }
  }

  function closeDetail() {
    state.openMint = "";
    detail.innerHTML = `<div class="df-detail-empty"><img src="${ROOT}assets/logo.svg" alt="" width="72" height="72" /><p>Pick a coin to see its chart and trade it.</p></div>`;
    list.querySelector(`[data-i="${state.selected}"]`)?.focus({ preventScroll: true });
  }

  async function refresh() {
    if (state.searching) return;
    try {
      const coins = state.query ? await fetchSearch(state.query) : await fetchTrending();
      state.coins = coins;
      renderList();
      status.textContent = `${coins.length} coins · updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} · data: Dexscreener`;
    } catch {
      status.textContent = "Dexscreener did not answer. Retrying in 20 seconds…";
    }
  }

  function setTab(tab) {
    state.tab = tab;
    document.querySelectorAll("[data-tab]").forEach((btn) => btn.setAttribute("aria-selected", String(btn.dataset.tab === tab)));
    renderList();
  }

  list.addEventListener("click", (event) => {
    const row = event.target.closest(".df-coin");
    if (row) select(Number(row.dataset.i), true);
  });

  detail.addEventListener("click", async (event) => {
    const act = event.target.closest("[data-act]")?.dataset.act;
    if (act === "close") closeDetail();
    if (act === "trade") openTrade();
    if (act === "copy" && state.openMint) {
      try {
        await navigator.clipboard.writeText(state.openMint);
        showToast("Contract address copied");
      } catch {
        showToast(state.openMint);
      }
    }
  });

  document.querySelectorAll("[data-tab]").forEach((btn) => btn.addEventListener("click", () => setTab(btn.dataset.tab)));

  $("#df-search").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.query = $("#df-q").value.trim().slice(0, 64);
    state.searching = false;
    list.innerHTML = '<p class="df-empty">Searching…</p>';
    await refresh();
  });

  $("#df-q").addEventListener("input", (event) => {
    if (!event.target.value.trim() && state.query) {
      state.query = "";
      refresh();
    }
  });

  const TABS = ["trending", "movers", "new"];
  function cycleTab(step) {
    setTab(TABS[(TABS.indexOf(state.tab) + step + TABS.length) % TABS.length]);
  }

  document.addEventListener("keydown", (event) => {
    if (event.target.closest("input, textarea, iframe")) return;
    if (!document.querySelector("#terminal").contains(document.activeElement) && !isTerminalInView()) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(state.selected + (event.key === "ArrowDown" ? 1 : -1), false);
    } else if (event.key === "Enter" && !event.target.closest("button, a")) {
      event.preventDefault();
      if (state.openMint === state.view[state.selected]?.mint) openTrade();
      else select(state.selected, true);
    } else if (event.key === "Escape") {
      closeDetail();
    }
  });

  function isTerminalInView() {
    const rect = document.querySelector("#terminal").getBoundingClientRect();
    return rect.top < window.innerHeight * 0.6 && rect.bottom > window.innerHeight * 0.3;
  }

  let padPrev = [];
  let padLoop = 0;
  function pollPad() {
    const pad = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (!pad) {
      padLoop = 0;
      return;
    }
    const pressed = pad.buttons.map((b) => b.pressed);
    const edge = (i) => pressed[i] && !padPrev[i];
    if (edge(12)) select(state.selected - 1, false);
    if (edge(13)) select(state.selected + 1, false);
    if (edge(14)) cycleTab(-1);
    if (edge(15)) cycleTab(1);
    if (edge(0)) {
      if (state.openMint === state.view[state.selected]?.mint) openTrade();
      else select(state.selected, true);
    }
    if (edge(1)) closeDetail();
    if (edge(4)) cycleTab(-1);
    if (edge(5)) cycleTab(1);
    padPrev = pressed;
    padLoop = requestAnimationFrame(pollPad);
  }

  window.addEventListener("gamepadconnected", () => {
    document.body.classList.add("has-pad");
    showToast("Controller connected · D-pad to move, ✕ to trade");
    document.querySelector("#terminal").scrollIntoView({ behavior: "smooth" });
    if (!padLoop) padLoop = requestAnimationFrame(pollPad);
  });

  window.addEventListener("gamepaddisconnected", () => {
    document.body.classList.remove("has-pad");
  });

  const countdown = $("#df-countdown");
  function tick() {
    const left = GTA_VI_NIGHT - Date.now();
    if (left <= 0) {
      countdown.textContent = "GTA VI is out · live";
      return;
    }
    const h = Math.floor(left / 3_600_000);
    const m = Math.floor((left % 3_600_000) / 60_000);
    const s = Math.floor((left % 60_000) / 1000);
    countdown.textContent = `GTA VI in ${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  }
  tick();
  setInterval(tick, 1000);

  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
})();
