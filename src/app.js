const STORAGE_KEY = "keep.media.v1";
const SETTINGS_KEY = "keep.settings.v1";
const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342";
const TAB_IDS = ["home", "queue", "search", "settings"];
const tabs = new Set(TAB_IDS);

const state = {
  tab: initialTab(),
  items: [],
  settings: { tmdbApiKey: "", theme: "light" },
  homeResults: [],
  homeLoading: false,
  homeError: "",
  filterStatus: "queued",
  filterType: "all",
  queueFiltersOpen: false,
  libraryQuery: "",
  searchQuery: "",
  searchType: "all",
  searchFiltersOpen: false,
  searchResults: [],
  searchLoading: false,
  searchError: "",
  pasteImporting: false,
  selected: null,
  pick: null,
  toast: ""
};

const $ = (selector) => document.querySelector(selector);
const app = $("#app");

function initialTab() {
  const hashTab = location.hash.replace("#", "");
  return tabs.has(hashTab) ? hashTab : "home";
}

const KeepStore = {
  load() {
    state.items = safeParse(localStorage.getItem(STORAGE_KEY), []);
    state.settings = { tmdbApiKey: "", theme: "light", ...safeParse(localStorage.getItem(SETTINGS_KEY), {}) };
    applyTheme();
  },
  saveItems() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
  },
  saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  },
  exportBackup() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: state.items,
      settings: { tmdbApiKey: state.settings.tmdbApiKey ? "__stored-locally__" : "" }
    };
  },
  importBackup(backup) {
    if (!backup || backup.version !== 1 || !Array.isArray(backup.items)) {
      throw new Error("Backup must be a Keep v1 JSON file.");
    }
    state.items = backup.items.map(normalizeItem);
    this.saveItems();
  }
};

function safeParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function uid(source, type, id) {
  return `${source}:${type}:${id}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeItem(item) {
  const stamped = now();
  return {
    id: item.id || uid(item.source || "manual", item.type || "movie", item.sourceId || crypto.randomUUID()),
    source: item.source || "manual",
    sourceId: String(item.sourceId || ""),
    type: item.type || "movie",
    title: item.title || "Untitled",
    originalTitle: item.originalTitle || "",
    year: item.year || "",
    overview: item.overview || "",
    posterUrl: item.posterUrl || "",
    popularity: Number(item.popularity || 0),
    status: ["queued", "watching", "watched"].includes(item.status) ? item.status : "queued",
    reaction: ["love", "like", "dislike"].includes(item.reaction) ? item.reaction : null,
    notes: item.notes || "",
    createdAt: item.createdAt || stamped,
    updatedAt: item.updatedAt || stamped
  };
}

const TmdbApi = {
  async search(query, type) {
    const key = state.settings.tmdbApiKey.trim();
    if (!key) throw new Error("Add a TMDB API key in Settings to search movies and TV.");
    const types = type === "movie" || type === "tv" ? [type] : ["movie", "tv"];
    const chunks = await Promise.all(
      types.map(async (mediaType) => {
        const url = new URL(`https://api.themoviedb.org/3/search/${mediaType}`);
        url.searchParams.set("api_key", key);
        url.searchParams.set("query", query);
        url.searchParams.set("include_adult", "false");
        const response = await fetch(url);
        if (!response.ok) throw new Error("TMDB search failed. Check your API key.");
        const data = await response.json();
        return (data.results || []).slice(0, 14).map((result) => mapTmdb(result, mediaType));
      })
    );
    return chunks.flat();
  },
  async recommendations(seed) {
    const key = state.settings.tmdbApiKey.trim();
    if (!key) throw new Error("Add a TMDB API key in Settings to build your discovery feed.");
    const resolved = seed.source === "tmdb" ? seed : await this.resolveSeed(seed);
    if (!resolved) return [];
    const url = new URL(`https://api.themoviedb.org/3/${resolved.type}/${resolved.sourceId}/recommendations`);
    url.searchParams.set("api_key", key);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Discovery feed failed. Try again.");
    const data = await response.json();
    return (data.results || []).slice(0, 10).map((result) => mapTmdb(result, resolved.type));
  },
  async resolveSeed(seed) {
    if (seed.source === "tmdb") return seed;
    if (seed.type !== "movie" && seed.type !== "tv") return null;
    const results = await this.search(seed.title, seed.type);
    return rankResults(results, seed.title)[0] || null;
  }
};

const JikanApi = {
  async search(query) {
    const url = new URL("https://api.jikan.moe/v4/anime");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "12");
    const response = await fetch(url);
    if (!response.ok) throw new Error("Anime search failed. Try again.");
    const data = await response.json();
    return (data.data || []).map(mapJikan);
  }
};

function mapTmdb(result, type) {
  const title = type === "movie" ? result.title : result.name;
  const date = type === "movie" ? result.release_date : result.first_air_date;
  return normalizeItem({
    id: uid("tmdb", type, result.id),
    source: "tmdb",
    sourceId: result.id,
    type,
    title,
    originalTitle: type === "movie" ? result.original_title : result.original_name,
    year: date ? date.slice(0, 4) : "",
    overview: result.overview || "",
    posterUrl: result.poster_path ? `${TMDB_IMAGE}${result.poster_path}` : "",
    popularity: result.popularity || 0,
    status: "queued"
  });
}

function mapJikan(result) {
  return normalizeItem({
    id: uid("jikan", "anime", result.mal_id),
    source: "jikan",
    sourceId: result.mal_id,
    type: "anime",
    title: result.title_english || result.title,
    originalTitle: result.title_japanese || "",
    year: result.year ? String(result.year) : "",
    overview: result.synopsis || "",
    posterUrl: result.images?.jpg?.image_url || "",
    popularity: result.popularity || 0,
    status: "queued"
  });
}

function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme === "dark" ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.settings.theme === "dark" ? "#101417" : "#f3f6f7");
}

function setState(patch) {
  Object.assign(state, patch);
  render();
}

function switchTab(tab) {
  if (!tabs.has(tab)) return;
  state.tab = tab;
  if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  render();
}

function toast(message) {
  state.toast = message;
  render();
  window.setTimeout(() => {
    if (state.toast === message) setState({ toast: "" });
  }, 2200);
}

function addOrUpdate(item, patch = {}) {
  const existing = state.items.find((entry) => entry.id === item.id);
  const updated = normalizeItem({ ...item, ...patch, updatedAt: now() });
  if (existing) {
    state.items = state.items.map((entry) => (entry.id === item.id ? { ...entry, ...updated, createdAt: entry.createdAt } : entry));
    toast("Updated");
  } else {
    state.items = [updated, ...state.items];
    toast("Added to queue");
  }
  state.homeResults = [];
  KeepStore.saveItems();
  render();
}

function addFromSearch(item) {
  if (!item) return;
  addOrUpdate(item);
  state.searchQuery = "";
  state.searchResults = [];
  state.searchError = "";
  state.searchLoading = false;
  state.selected = null;
  render();
}

function updateItem(id, patch) {
  state.items = state.items.map((item) => (item.id === id ? normalizeItem({ ...item, ...patch, updatedAt: now() }) : item));
  KeepStore.saveItems();
  render();
}

function deleteItem(id) {
  state.items = state.items.filter((item) => item.id !== id);
  state.selected = null;
  KeepStore.saveItems();
  toast("Removed");
}

function filteredItems() {
  const query = state.libraryQuery.trim().toLowerCase();
  return state.items.filter((item) => {
    const statusMatch = state.filterStatus === "all" || item.status === state.filterStatus;
    const typeMatch = state.filterType === "all" || item.type === state.filterType;
    const queryMatch = !query || `${item.title} ${item.year} ${item.type}`.toLowerCase().includes(query);
    return statusMatch && typeMatch && queryMatch;
  });
}

async function runSearch(event) {
  event?.preventDefault();
  const query = state.searchQuery.trim();
  if (!query) return;
  setState({ searchLoading: true, searchError: "", searchResults: [] });
  try {
    const searches = [];
    if (state.searchType !== "anime") searches.push(TmdbApi.search(query, state.searchType));
    if (state.searchType === "anime") searches.push(JikanApi.search(query));
    const settled = await Promise.allSettled(searches);
    const results = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const errors = settled.filter((result) => result.status === "rejected");
    setState({
      searchResults: rankResults(results, query),
      searchError: results.length ? "" : errors[0]?.reason?.message || "No results found.",
      searchLoading: false
    });
  } catch (error) {
    setState({ searchError: error.message, searchLoading: false });
  }
}

function rankResults(results, query) {
  return [...results].sort((a, b) => searchScore(b, query) - searchScore(a, query));
}

function searchScore(item, query) {
  const q = normalizeText(query);
  const title = normalizeText(item.title);
  const original = normalizeText(item.originalTitle);
  const compactQ = compactText(query);
  const compactTitle = compactText(item.title);
  const compactOriginal = compactText(item.originalTitle);
  let score = 0;
  if (title === q || original === q) score += 1000;
  if (compactTitle === compactQ || compactOriginal === compactQ) score += 900;
  if (title.startsWith(q) || original.startsWith(q)) score += 500;
  if (compactTitle.startsWith(compactQ) || compactOriginal.startsWith(compactQ)) score += 460;
  if (title.includes(q) || original.includes(q)) score += 200;
  if (compactTitle.includes(compactQ) || compactOriginal.includes(compactQ)) score += 180;
  score += fuzzyScore(compactQ, compactTitle);
  score += fuzzyScore(compactQ, compactOriginal);
  if (item.type === "tv") score += 18;
  if (item.type === "movie") score += 10;
  score += Math.min(Number(item.popularity || 0), 150);
  return score;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function fuzzyScore(query, target) {
  if (!query || !target) return 0;
  const distance = levenshtein(query.slice(0, 36), target.slice(0, 36));
  const max = Math.max(query.length, target.length, 1);
  const similarity = 1 - distance / max;
  let score = Math.max(0, similarity) * 120;
  if (isSubsequence(query, target)) score += 70;
  if (query.length <= 4 && target.startsWith(query)) score += 80;
  return score;
}

function isSubsequence(needle, haystack) {
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j - 1], row[j]) + 1;
      prev = next;
    }
  }
  return row[b.length];
}

async function refreshHome(force = false) {
  if (state.homeLoading || (!force && state.homeResults.length)) return;
  const seeds = state.items.filter((item) => item.type === "movie" || item.type === "tv").slice(0, 6);
  if (!seeds.length) {
    if (state.homeResults.length || state.homeError) setState({ homeResults: [], homeError: "" });
    return;
  }
  setState({ homeLoading: true, homeError: "" });
  try {
    const settled = await Promise.allSettled(seeds.map((seed) => TmdbApi.recommendations(seed)));
    const savedIds = new Set(state.items.map((item) => item.id));
    const deduped = new Map();
    settled
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((item) => !savedIds.has(item.id))
      .forEach((item) => {
        if (!deduped.has(item.id)) deduped.set(item.id, item);
      });
    const homeResults = [...deduped.values()].sort((a, b) => Number(b.popularity || 0) - Number(a.popularity || 0)).slice(0, 18);
    const firstError = settled.find((result) => result.status === "rejected")?.reason?.message;
    setState({ homeResults, homeError: homeResults.length ? "" : firstError || "No recommendations yet.", homeLoading: false });
  } catch (error) {
    setState({ homeError: error.message, homeLoading: false });
  }
}

function randomPick() {
  const pool = filteredItems().filter((item) => item.status === "queued");
  if (!pool.length) {
    toast("No queued items in this filter");
    return;
  }
  state.pick = pool[Math.floor(Math.random() * pool.length)];
  render();
}

function render() {
  app.innerHTML = `
    <main class="shell">
      ${state.tab === "home" ? homeView() : ""}
      ${state.tab === "queue" ? queueView() : ""}
      ${state.tab === "search" ? searchView() : ""}
      ${state.tab === "settings" ? settingsView() : ""}
    </main>
    ${tabBar()}
    ${state.selected ? detailSheet(state.selected) : ""}
    ${state.pick ? pickSheet(state.pick) : ""}
    ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
  `;
  bindEvents();
  if (state.tab === "home") refreshHome();
}

function homeView() {
  const seeds = state.items.filter((item) => item.type === "movie" || item.type === "tv");
  return `
    <section class="view">
      <header class="topbar">
        <div>
          <p class="eyebrow">Based on queue</p>
          <h1>Home</h1>
        </div>
        <button class="icon-button" data-action="refreshHome" aria-label="Refresh discovery">${icon("refresh")}</button>
      </header>
      ${!state.settings.tmdbApiKey ? `<div class="notice">Discovery needs your TMDB API key. <button data-tab="settings">Add key</button></div>` : ""}
      ${state.settings.tmdbApiKey && !seeds.length ? emptyState("Build your feed", "Add a movie or TV show to your queue, then Home will recommend more.") : ""}
      ${state.homeLoading ? `<div class="loading">Finding matches...</div>` : ""}
      ${state.homeError ? `<div class="notice">${escapeHtml(state.homeError)}</div>` : ""}
      <div class="discovery-grid">
        ${state.homeResults.map(discoveryCard).join("")}
      </div>
    </section>
  `;
}

function queueView() {
  const items = filteredItems();
  return `
    <section class="view">
      <header class="topbar">
        <div>
          <p class="eyebrow">${state.items.length} saved</p>
          <h1>Keep</h1>
        </div>
        <button class="icon-button" data-action="pick" aria-label="Pick random title">${icon("shuffle")}</button>
      </header>
      <div class="field search-field">
        ${icon("search")}
        <input data-field="libraryQuery" value="${escapeAttr(state.libraryQuery)}" placeholder="Search your library" />
      </div>
      <details class="filter-drawer" data-filter-drawer="queueFiltersOpen" ${state.queueFiltersOpen ? "open" : ""}>
        <summary>${icon("filter")} Filters <span>${queueFilterLabel()}</span></summary>
        <div class="filter-stack">
          <div class="chip-row">${chips("filterStatus", ["queued", "watching", "watched", "all"])}</div>
          <div class="chip-row">${chips("filterType", ["all", "movie", "tv", "anime"])}</div>
        </div>
      </details>
      <div class="queue-grid">
        ${items.length ? items.map(queueCard).join("") : emptyState("No titles here", "Add something from Search or change filters.")}
      </div>
    </section>
  `;
}

function searchView() {
  return `
    <section class="view">
      <header class="topbar">
        <div>
          <p class="eyebrow">${state.searchType === "anime" ? "Jikan" : "TMDB"}</p>
          <h1>Search</h1>
        </div>
      </header>
      <form class="search-form" data-action="search">
        <div class="field search-field">
          ${icon("search")}
          <input data-field="searchQuery" value="${escapeAttr(state.searchQuery)}" placeholder="Movie or show" />
        </div>
        <button class="primary-button" type="submit">Search</button>
      </form>
      <details class="filter-drawer" data-filter-drawer="searchFiltersOpen" ${state.searchFiltersOpen ? "open" : ""}>
        <summary>${icon("filter")} Filters <span>${searchFilterLabel()}</span></summary>
        <div class="chip-row">${chips("searchType", ["all", "movie", "tv", "anime"])}</div>
      </details>
      ${!state.settings.tmdbApiKey && state.searchType !== "anime" ? setupPrompt() : ""}
      ${state.searchLoading ? `<div class="loading">Searching...</div>` : ""}
      ${state.searchError ? `<div class="notice">${escapeHtml(state.searchError)}</div>` : ""}
      <div class="list">
        ${state.searchResults.map(searchCard).join("")}
      </div>
    </section>
  `;
}

function settingsView() {
  return `
    <section class="view">
      <header class="topbar">
        <div>
          <p class="eyebrow">Local-first</p>
          <h1>Settings</h1>
        </div>
      </header>
      <section class="panel">
        <label class="toggle-row">
          <span><strong>Dark mode</strong><small>Use dark theme across Keep.</small></span>
          <input type="checkbox" data-action="theme" ${state.settings.theme === "dark" ? "checked" : ""} />
        </label>
      </section>
      <section class="panel">
        <label class="label" for="tmdb-key">TMDB API key</label>
        <input id="tmdb-key" class="text-input" data-field="tmdbApiKey" value="${escapeAttr(state.settings.tmdbApiKey)}" placeholder="Paste key" />
        <p class="help">Stored only in this browser. Used for movie and TV search.</p>
      </section>
      <details class="panel setup-guide">
        <summary>${icon("key")} TMDB setup guide</summary>
        <ol>
          <li>Go to <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer">themoviedb.org/signup</a> and make a free account.</li>
          <li>Open Settings on TMDB, then API, then request a Developer API key.</li>
          <li>Choose personal use, fill the short form, and copy the API key.</li>
          <li>Paste it into the TMDB API key field above. Search and Home discovery will start working.</li>
        </ol>
        <p class="help">Each friend uses their own key. Keep stores it only on their device.</p>
      </details>
      <section class="panel grid-actions">
        <button class="secondary-button" data-action="export">${icon("download")} Export JSON</button>
        <label class="secondary-button file-button">${icon("upload")} Import JSON<input type="file" accept="application/json" data-action="import" /></label>
      </section>
      <section class="panel">
        <label class="label" for="paste-list">Paste titles</label>
        <textarea id="paste-list" data-paste-list placeholder="1. Twin Peaks&#10;- Redline&#10;• Lost in Translation"></textarea>
        <p class="help">Reads numbered lists, bullets, dashes, and plain lines, then matches each title through TMDB.</p>
        <button class="primary-button full-button" data-action="importPaste" ${state.pasteImporting ? "disabled" : ""}>${icon("plus")} ${state.pasteImporting ? "Matching..." : "Add pasted titles"}</button>
      </section>
      <section class="panel danger-zone">
        <p><strong>Clear local data</strong><span>Removes saved titles on this browser.</span></p>
        <button class="danger-button" data-action="clear">Clear</button>
      </section>
    </section>
  `;
}

function discoveryCard(item) {
  const saved = state.items.find((entry) => entry.id === item.id);
  return `
    <article class="discovery-card">
      <button class="row-hit" data-preview-home="${escapeAttr(item.id)}" aria-label="Preview ${escapeAttr(item.title)}"></button>
      ${poster(item)}
      <div class="discovery-title">${escapeHtml(item.title)}</div>
      <div class="media-meta">${label(item.type)}${item.year ? ` · ${escapeHtml(item.year)}` : ""}</div>
      <button class="secondary-button" data-add-home="${escapeAttr(item.id)}">${saved ? "Saved" : "+ Queue"}</button>
    </article>
  `;
}

function itemCard(item) {
  return `
    <article class="media-row" data-open="${escapeAttr(item.id)}">
      ${poster(item)}
      <div class="media-body">
        <div class="media-title">${escapeHtml(item.title)}</div>
        <div class="media-meta">${label(item.type)}${item.year ? ` · ${escapeHtml(item.year)}` : ""}</div>
        <div class="media-tags">
          <span>${label(item.status)}</span>
          ${item.reaction ? `<span>${reactionIcon(item.reaction)} ${label(item.reaction)}</span>` : ""}
        </div>
      </div>
      <button class="ghost-icon" data-quick-status="${escapeAttr(item.id)}" aria-label="Cycle status">${icon("check")}</button>
    </article>
  `;
}

function queueCard(item) {
  return `
    <article class="queue-card" data-open="${escapeAttr(item.id)}">
      ${poster(item)}
      <div class="queue-card-body">
        <div class="media-title">${escapeHtml(item.title)}</div>
        <div class="media-meta">${label(item.type)}${item.year ? ` · ${escapeHtml(item.year)}` : ""}</div>
      </div>
      <div class="media-tags">
        <span>${label(item.status)}</span>
        ${item.reaction ? `<span>${reactionIcon(item.reaction)} ${label(item.reaction)}</span>` : ""}
      </div>
      <button class="ghost-icon queue-status" data-quick-status="${escapeAttr(item.id)}" aria-label="Cycle status">${icon("check")}</button>
    </article>
  `;
}

function searchCard(item) {
  const saved = state.items.find((entry) => entry.id === item.id);
  return `
    <article class="media-row">
      <button class="row-hit" data-preview="${escapeAttr(item.id)}" aria-label="Preview ${escapeAttr(item.title)}"></button>
      ${poster(item)}
      <div class="media-body">
        <div class="media-title">${escapeHtml(item.title)}</div>
        <div class="media-meta">${label(item.type)}${item.year ? ` · ${escapeHtml(item.year)}` : ""}</div>
        <p class="summary">${escapeHtml(item.overview || "No summary available.")}</p>
      </div>
      <button class="add-button" data-add="${escapeAttr(item.id)}">${saved ? "Saved" : "+"}</button>
    </article>
  `;
}

function detailSheet(item) {
  const saved = state.items.find((entry) => entry.id === item.id) || item;
  return `
    <div class="scrim" data-action="close"></div>
    <aside class="sheet">
      <div class="grabber"></div>
      <div class="detail-head">
        ${poster(saved)}
        <div>
          <p class="eyebrow">${label(saved.type)}${saved.year ? ` · ${escapeHtml(saved.year)}` : ""}</p>
          <h2>${escapeHtml(saved.title)}</h2>
        </div>
      </div>
      ${saved.overview ? `<p class="detail-copy">${escapeHtml(saved.overview)}</p>` : ""}
      <div class="control-group">
        <span class="label">Status</span>
        <div class="segmented">${segments("status", ["queued", "watching", "watched"], saved.status, saved.id)}</div>
      </div>
      <div class="control-group">
        <span class="label">Reaction</span>
        <div class="segmented">${segments("reaction", ["love", "like", "dislike", "none"], saved.reaction || "none", saved.id)}</div>
      </div>
      <label class="label" for="notes">Notes</label>
      <textarea id="notes" data-notes="${escapeAttr(saved.id)}" placeholder="Private notes">${escapeHtml(saved.notes || "")}</textarea>
      <div class="sheet-actions">
        ${state.items.some((entry) => entry.id === saved.id) ? `<button class="danger-button" data-delete="${escapeAttr(saved.id)}">Remove</button>` : ""}
        <button class="primary-button" data-save-detail="${escapeAttr(saved.id)}">Save</button>
      </div>
    </aside>
  `;
}

function pickSheet(item) {
  return `
    <div class="scrim" data-action="closePick"></div>
    <aside class="sheet pick-sheet">
      <div class="grabber"></div>
      <p class="eyebrow">Tonight pick</p>
      ${poster(item)}
      <h2>${escapeHtml(item.title)}</h2>
      <p class="detail-copy">${escapeHtml(item.overview || "No summary saved.")}</p>
      <div class="sheet-actions">
        <button class="secondary-button" data-action="pick">Pick again</button>
        <button class="primary-button" data-open="${escapeAttr(item.id)}">Open</button>
      </div>
    </aside>
  `;
}

function tabBar() {
  return `
    <nav class="tabbar" aria-label="Main">
      ${tab("home", "home", "Home")}
      ${tab("queue", "list", "Queue")}
      ${tab("search", "search", "Search")}
      ${tab("settings", "settings", "Settings")}
    </nav>
  `;
}

function tab(id, iconName, text) {
  return `<button class="${state.tab === id ? "active" : ""}" data-tab="${id}">${icon(iconName)}<span>${text}</span></button>`;
}

function chips(field, values) {
  return values
    .map((value) => `<button class="chip ${state[field] === value ? "active" : ""}" data-chip="${field}:${value}">${field === "searchType" && value === "all" ? "Movies + TV" : label(value)}</button>`)
    .join("");
}

function searchFilterLabel() {
  return state.searchType === "all" ? "Movies + TV" : label(state.searchType);
}

function queueFilterLabel() {
  const status = label(state.filterStatus);
  const type = state.filterType === "all" ? "All media" : label(state.filterType);
  return `${status} · ${type}`;
}

function segments(field, values, current, id) {
  return values
    .map(
      (value) =>
        `<button class="${current === value ? "active" : ""}" data-segment data-segment-field="${field}" data-segment-value="${value}" data-segment-id="${escapeAttr(id)}">${field === "reaction" ? reactionIcon(value) : ""}${label(value)}</button>`
    )
    .join("");
}

function poster(item) {
  return item.posterUrl
    ? `<img class="poster" src="${escapeAttr(item.posterUrl)}" alt="" loading="lazy" />`
    : `<div class="poster poster-empty">${icon(item.type === "anime" ? "spark" : "film")}</div>`;
}

function emptyState(title, body) {
  return `<div class="empty"><h2>${title}</h2><p>${body}</p><button class="primary-button" data-tab="search">Search media</button></div>`;
}

function setupPrompt() {
  return `<div class="notice">Movie and TV search needs a TMDB API key. <button data-tab="settings">Add key</button></div>`;
}

function bindEvents() {
  app.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  app.querySelectorAll("[data-chip]").forEach((button) =>
    button.addEventListener("click", () => {
      const [field, value] = button.dataset.chip.split(":");
      setState({ [field]: value });
    })
  );
  app.querySelectorAll("[data-filter-drawer]").forEach((drawer) => {
    drawer.addEventListener("toggle", (event) => {
      state[event.currentTarget.dataset.filterDrawer] = event.currentTarget.open;
    });
  });
  app.querySelectorAll("[data-field]").forEach((input) => {
    input.addEventListener("input", () => {
      const field = input.dataset.field;
      if (field === "tmdbApiKey") {
        state.settings.tmdbApiKey = input.value.trim();
        state.homeResults = [];
        KeepStore.saveSettings();
      } else {
        state[field] = input.value;
      }
    });
  });
  app.querySelector('[data-action="search"]')?.addEventListener("submit", runSearch);
  app.querySelector("[data-action='refreshHome']")?.addEventListener("click", () => refreshHome(true));
  app.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => addFromSearch(state.searchResults.find((item) => item.id === button.dataset.add))));
  app.querySelectorAll("[data-add-home]").forEach((button) => button.addEventListener("click", () => addOrUpdate(state.homeResults.find((item) => item.id === button.dataset.addHome))));
  app.querySelectorAll("[data-preview]").forEach((button) => button.addEventListener("click", () => setState({ selected: state.searchResults.find((item) => item.id === button.dataset.preview) })));
  app.querySelectorAll("[data-preview-home]").forEach((button) => button.addEventListener("click", () => setState({ selected: state.homeResults.find((item) => item.id === button.dataset.previewHome) })));
  app.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => setState({ selected: state.items.find((item) => item.id === el.dataset.open), pick: null })));
  app.querySelectorAll("[data-action='close']").forEach((el) => el.addEventListener("click", () => setState({ selected: null })));
  app.querySelectorAll("[data-action='closePick']").forEach((el) => el.addEventListener("click", () => setState({ pick: null })));
  app.querySelectorAll("[data-action='pick']").forEach((el) => el.addEventListener("click", randomPick));
  app.querySelectorAll("[data-quick-status]").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const item = state.items.find((entry) => entry.id === button.dataset.quickStatus);
      const next = item.status === "queued" ? "watching" : item.status === "watching" ? "watched" : "queued";
      updateItem(item.id, { status: next });
    })
  );
  app.querySelectorAll("[data-segment]").forEach((button) =>
    button.addEventListener("click", () => {
      const field = button.dataset.segmentField;
      const value = button.dataset.segmentValue;
      const id = button.dataset.segmentId;
      const current = state.items.find((item) => item.id === id) || state.selected;
      const patch = { [field]: value === "none" ? null : value };
      if (state.items.some((item) => item.id === id)) updateItem(id, patch);
      state.selected = normalizeItem({ ...current, ...patch });
      render();
    })
  );
  app.querySelector("[data-save-detail]")?.addEventListener("click", (event) => {
    const id = event.currentTarget.dataset.saveDetail;
    const notes = app.querySelector(`[data-notes="${CSS.escape(id)}"]`)?.value || "";
    addOrUpdate(state.selected, { notes });
    setState({ selected: null });
  });
  app.querySelector("[data-delete]")?.addEventListener("click", (event) => {
    if (confirm("Remove this title from Keep?")) deleteItem(event.currentTarget.dataset.delete);
  });
  app.querySelector("[data-action='export']")?.addEventListener("click", exportBackup);
  app.querySelector("[data-action='import']")?.addEventListener("change", importBackup);
  app.querySelector("[data-action='importPaste']")?.addEventListener("click", importPastedList);
  app.querySelector("[data-action='clear']")?.addEventListener("click", () => {
    if (confirm("Clear all saved titles from this browser?")) {
      state.items = [];
      KeepStore.saveItems();
      toast("Library cleared");
    }
  });
  app.querySelector("[data-action='theme']")?.addEventListener("change", (event) => {
    state.settings.theme = event.target.checked ? "dark" : "light";
    KeepStore.saveSettings();
    applyTheme();
    render();
  });
}

async function importPastedList() {
  const textarea = app.querySelector("[data-paste-list]");
  const titles = parseTitleList(textarea?.value || "");
  if (!titles.length) {
    toast("No titles found");
    return;
  }
  if (!state.settings.tmdbApiKey.trim()) {
    toast("Add TMDB key first");
    return;
  }
  setState({ pasteImporting: true });
  const existing = new Set(state.items.map((item) => item.id));
  const seenTitles = new Set(state.items.map((item) => compactText(item.title)));
  const additions = [];
  const missed = [];
  for (const title of titles) {
    if (seenTitles.has(compactText(title))) continue;
    try {
      const match = await resolvePastedTitle(title);
      if (match && !existing.has(match.id)) {
        additions.push(match);
        existing.add(match.id);
        seenTitles.add(compactText(match.title));
      } else {
        missed.push(title);
      }
    } catch {
      missed.push(title);
    }
  }
  state.pasteImporting = false;
  if (!additions.length) {
    toast(missed.length ? "No matches found" : "Already saved");
    render();
    return;
  }
  state.items = [...additions, ...state.items];
  state.homeResults = [];
  KeepStore.saveItems();
  if (textarea) textarea.value = "";
  toast(missed.length ? `Added ${additions.length}, missed ${missed.length}` : `Added ${additions.length}`);
  render();
}

async function resolvePastedTitle(title) {
  const results = await TmdbApi.search(title, "all");
  const [best] = rankResults(results, title);
  return best ? normalizeItem({ ...best, status: "queued" }) : null;
}

function parseTitleList(text) {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•‣–—]|(?:\d+|[a-zA-Z])[.)]|☐|☑|✓)\s*/, "")
        .replace(/\s+#\w+\s*$/, "")
        .trim()
    )
    .filter(Boolean);
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(KeepStore.exportBackup(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `keep-backup-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importBackup(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    KeepStore.importBackup(JSON.parse(await file.text()));
    toast("Backup imported");
  } catch (error) {
    toast(error.message);
  }
}

function label(value) {
  return {
    all: "All",
    movie: "Movie",
    tv: "TV",
    anime: "Anime",
    queued: "Queue",
    watching: "Watching",
    watched: "Watched",
    love: "Love",
    like: "Like",
    dislike: "Dislike",
    none: "None"
  }[value] || value;
}

function reactionIcon(value) {
  return { love: "♥", like: "↑", dislike: "↓", none: "" }[value] || "";
}

function icon(name) {
  const icons = {
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-1.9.3 1.7 1.7 0 0 0-.8 1.6V22H9v-.2a1.7 1.7 0 0 0-.8-1.6 1.7 1.7 0 0 0-1.9-.3l-.2.1-2-3.4.1-.1A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14H2v-4h1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3.4.2.1a1.7 1.7 0 0 0 1.9-.3A1.7 1.7 0 0 0 9 1.8V2h6v-.2a1.7 1.7 0 0 0 .8 1.6 1.7 1.7 0 0 0 1.9.3l.2-.1 2 3.4-.1.1A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 21 10h1v4h-1a1.7 1.7 0 0 0-1.6 1Z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="m4 4 5 5"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m20 6-11 11-5-5"/></svg>',
    film: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M16 3v18M4 8h4M4 16h4M16 8h4M16 16h4"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 2 9 9l-7 3 7 3 3 7 3-7 7-3-7-3-3-7Z"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>',
    upload: '<svg viewBox="0 0 24 24"><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    filter: '<svg viewBox="0 0 24 24"><path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="M3 11 12 3l9 8"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>',
    refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 0 1-15.5 6.2"/><path d="M3 12A9 9 0 0 1 18.5 5.8"/><path d="M18 2v4h-4"/><path d="M6 22v-4h4"/></svg>'
    ,key: '<svg viewBox="0 0 24 24"><circle cx="7.5" cy="14.5" r="4.5"/><path d="M11 11 21 1"/><path d="m16 6 2 2"/><path d="m14 8 2 2"/></svg>'
  };
  return icons[name] || "";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

KeepStore.load();
render();

window.addEventListener("hashchange", () => switchTab(initialTab()));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
