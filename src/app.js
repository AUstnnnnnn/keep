const STORAGE_KEY = "keep.media.v1";
const SETTINGS_KEY = "keep.settings.v1";
const LISTS_KEY = "keep.lists.v1";
const TMDB_IMAGE = "https://image.tmdb.org/t/p/w342";
const TAB_IDS = ["home", "library", "search", "settings"];
const tabs = new Set(TAB_IDS);
const TAB_ALIASES = { queue: "library" };

const state = {
  tab: initialTab(),
  items: [],
  lists: [],
  settings: { tmdbApiKey: "", theme: "light" },
  homeResults: [],
  homeLoading: false,
  homeError: "",
  homePage: 0,
  homeHasMore: true,
  composingList: false,
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
  editingListId: null,
  pick: null,
  updating: false
};

const $ = (selector) => document.querySelector(selector);
const app = $("#app");

function initialTab() {
  const hashTab = location.hash.replace("#", "");
  const aliased = TAB_ALIASES[hashTab] || hashTab;
  return tabs.has(aliased) ? aliased : "home";
}

const KeepStore = {
  load() {
    state.items = safeParse(localStorage.getItem(STORAGE_KEY), []);
    state.lists = safeParse(localStorage.getItem(LISTS_KEY), []).map(normalizeList);
    state.settings = { tmdbApiKey: "", theme: "light", ...safeParse(localStorage.getItem(SETTINGS_KEY), {}) };
    applyTheme();
  },
  saveItems() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items));
  },
  saveLists() {
    localStorage.setItem(LISTS_KEY, JSON.stringify(state.lists));
  },
  saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  },
  exportBackup() {
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      items: state.items,
      lists: state.lists,
      settings: { tmdbApiKey: state.settings.tmdbApiKey ? "__stored-locally__" : "" }
    };
  },
  importBackup(backup) {
    if (!backup || !Array.isArray(backup.items) || (backup.version !== 1 && backup.version !== 2)) {
      throw new Error("Backup must be a Keep v1 or v2 JSON file.");
    }
    state.items = backup.items.map(normalizeItem);
    state.lists = Array.isArray(backup.lists) ? backup.lists.map(normalizeList) : [];
    this.saveItems();
    this.saveLists();
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

function normalizeList(list) {
  return {
    id: list.id || `list:${crypto.randomUUID()}`,
    name: String(list.name || "Untitled list").slice(0, 80),
    itemIds: Array.isArray(list.itemIds) ? list.itemIds.filter(Boolean) : [],
    createdAt: list.createdAt || now()
  };
}

function createList(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  const list = normalizeList({ name: trimmed });
  state.lists = [list, ...state.lists];
  KeepStore.saveLists();
  return list;
}

function toggleItemInList(listId, itemId) {
  state.lists = state.lists.map((list) => {
    if (list.id !== listId) return list;
    const ids = list.itemIds.includes(itemId) ? list.itemIds.filter((id) => id !== itemId) : [...list.itemIds, itemId];
    return { ...list, itemIds: ids };
  });
  KeepStore.saveLists();
}

function renameList(listId, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return;
  state.lists = state.lists.map((list) => (list.id === listId ? { ...list, name: trimmed.slice(0, 80) } : list));
  KeepStore.saveLists();
}

function deleteList(listId) {
  state.lists = state.lists.filter((list) => list.id !== listId);
  KeepStore.saveLists();
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
    voteAverage: Number(item.voteAverage || 0),
    voteCount: Number(item.voteCount || 0),
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
  async recommendations(seed, page = 1) {
    const key = state.settings.tmdbApiKey.trim();
    if (!key) throw new Error("Add a TMDB API key in Settings to build your discovery feed.");
    const resolved = seed.source === "tmdb" ? seed : await this.resolveSeed(seed);
    if (!resolved) return [];
    const endpoints = ["recommendations", "similar"];
    const chunks = await Promise.all(
      endpoints.map(async (endpoint) => {
        const url = new URL(`https://api.themoviedb.org/3/${resolved.type}/${resolved.sourceId}/${endpoint}`);
        url.searchParams.set("api_key", key);
        url.searchParams.set("page", String(page));
        const response = await fetch(url);
        if (!response.ok) throw new Error("Discovery feed failed. Try again.");
        const data = await response.json();
        return (data.results || []).map((result) => mapTmdb(result, resolved.type));
      })
    );
    return chunks.flat();
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
    voteAverage: result.vote_average || 0,
    voteCount: result.vote_count || 0,
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

let toastNode = null;
let toastTimer = 0;
function toast(message) {
  if (!toastNode) {
    toastNode = document.createElement("div");
    toastNode.className = "toast";
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = message;
  toastNode.classList.add("toast-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastNode?.classList.remove("toast-visible");
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
  state.lists = state.lists.map((list) => ({ ...list, itemIds: list.itemIds.filter((itemId) => itemId !== id) }));
  state.selected = null;
  state.homeResults = [];
  KeepStore.saveItems();
  KeepStore.saveLists();
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
  if (force) {
    state.homeResults = [];
    state.homePage = 0;
    state.homeHasMore = true;
    state.homeError = "";
  }
  if (!state.homeResults.length) await loadHomeResults(false);
}

async function loadHomeResults(append) {
  if (state.homeLoading || (append && !state.homeHasMore)) return;
  const seeds = rankedSeeds().slice(0, 8);
  if (!seeds.length) {
    setState({ homeResults: [], homeError: "", homeHasMore: false });
    return;
  }
  const nextPage = append ? state.homePage + 1 : 1;
  setState({ homeLoading: true, homeError: append ? state.homeError : "" });
  try {
    const seedWeights = new Map(seeds.map((seed, index) => [seed.id, seedWeight(seed) + (8 - index) * 4]));
    const settled = await Promise.allSettled(
      seeds.map((seed) => TmdbApi.recommendations(seed, nextPage).then((items) => ({ seed, items })))
    );
    const savedIds = new Set(state.items.map((item) => item.id));
    const existingIds = new Set(append ? state.homeResults.map((item) => item.id) : []);
    const deduped = new Map();
    settled
      .flatMap((result) => (result.status === "fulfilled" ? result.value.items.map((item) => ({ item, seed: result.value.seed })) : []))
      .filter(({ item }) => isUsefulRecommendation(item) && !savedIds.has(item.id) && !existingIds.has(item.id))
      .forEach(({ item, seed }) => {
        const current = deduped.get(item.id) || { item, score: 0, hits: 0 };
        current.hits += 1;
        current.score += recommendationScore(item, seedWeights.get(seed.id) || 0);
        deduped.set(item.id, current);
      });
    const batch = [...deduped.values()]
      .sort((a, b) => b.score + b.hits * 55 - (a.score + a.hits * 55))
      .map((entry) => entry.item);
    const firstError = settled.find((result) => result.status === "rejected")?.reason?.message;
    const next = append ? [...state.homeResults, ...batch] : batch;
    setState({
      homeResults: next,
      homePage: nextPage,
      homeHasMore: batch.length > 0 && nextPage < 8,
      homeError: next.length ? "" : firstError || "No recommendations yet.",
      homeLoading: false
    });
  } catch (error) {
    setState({ homeError: error.message, homeLoading: false, homeHasMore: false });
  }
}

let homeObserver = null;
function attachHomeObserver() {
  homeObserver?.disconnect();
  homeObserver = null;
  if (state.tab !== "home") return;
  const sentinel = app.querySelector("[data-home-sentinel]");
  if (!sentinel) return;
  homeObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && state.homeHasMore && !state.homeLoading) {
        loadHomeResults(true);
      }
    },
    { rootMargin: "400px 0px" }
  );
  homeObserver.observe(sentinel);
}

function rankedSeeds() {
  return state.items
    .filter((item) => item.type === "movie" || item.type === "tv")
    .sort((a, b) => seedWeight(b) - seedWeight(a) || new Date(b.updatedAt) - new Date(a.updatedAt));
}

function seedWeight(item) {
  const reaction = { love: 70, like: 45, dislike: -80 }[item.reaction] || 0;
  const status = { watched: 35, watching: 28, queued: 8 }[item.status] || 0;
  return reaction + status + Math.min(Number(item.popularity || 0), 35);
}

function isUsefulRecommendation(item) {
  if (!item.posterUrl || !item.overview) return false;
  if (Number(item.voteCount || 0) && Number(item.voteCount || 0) < 25) return false;
  if (Number(item.voteAverage || 0) && Number(item.voteAverage || 0) < 5.2) return false;
  return Number(item.popularity || 0) >= 2;
}

function recommendationScore(item, seed) {
  return seed + Math.min(Number(item.popularity || 0), 90) + Math.min(Number(item.voteCount || 0) / 20, 55) + Number(item.voteAverage || 0) * 8;
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
      ${state.tab === "library" ? libraryView() : ""}
      ${state.tab === "search" ? searchView() : ""}
      ${state.tab === "settings" ? settingsView() : ""}
    </main>
    ${tabBar()}
    ${state.selected ? detailSheet(state.selected) : ""}
    ${state.pick ? pickSheet(state.pick) : ""}
    ${state.editingListId ? listEditorSheet() : ""}
  `;
  bindEvents();
  if (state.tab === "home") {
    refreshHome();
    attachHomeObserver();
  } else {
    homeObserver?.disconnect();
  }
}

function homeView() {
  const seeds = state.items.filter((item) => item.type === "movie" || item.type === "tv");
  const needsKey = !state.settings.tmdbApiKey;
  const needsSeeds = !needsKey && !seeds.length;
  return `
    <section class="view">
      <header class="topbar">
        <div>
          <p class="eyebrow">Recommended</p>
          <h1>Home</h1>
        </div>
        <button class="icon-button" data-action="refreshHome" aria-label="Refresh recommendations">${icon("refresh")}</button>
      </header>
      ${needsKey ? `<div class="notice">Recommendations need your TMDB API key. <button data-tab="settings">Add key</button></div>` : ""}
      ${needsSeeds ? emptyState("Build your feed", "Add a movie or TV show to your library — Home will fill with picks based on your queue and ratings.") : ""}
      ${state.homeError && !state.homeResults.length && !needsKey && !needsSeeds ? `<div class="notice">${escapeHtml(state.homeError)}</div>` : ""}
      ${!needsKey && !needsSeeds ? `
        <div class="recs-grid">
          ${state.homeResults.map(recCard).join("")}
          ${state.homeLoading ? recSkeletons(state.homeResults.length ? 6 : 12) : ""}
        </div>
        ${state.homeHasMore && state.homeResults.length ? `<div class="home-sentinel" data-home-sentinel aria-hidden="true"></div>` : ""}
      ` : ""}
    </section>
  `;
}

function recCard(item) {
  return `
    <button class="rec-card" data-preview-home="${escapeAttr(item.id)}" aria-label="${escapeAttr(item.title)}">
      ${poster(item)}
    </button>
  `;
}

function recSkeletons(count) {
  return Array.from({ length: count }, () => `<div class="rec-skeleton" aria-hidden="true"></div>`).join("");
}

function libraryView() {
  const items = filteredItems();
  return `
    <section class="view">
      <header class="topbar">
        <div>
          <p class="eyebrow">${state.items.length} saved</p>
          <h1>Library</h1>
        </div>
        <button class="icon-button" data-action="pick" aria-label="Pick random title">${icon("shuffle")}</button>
      </header>

      <section class="lib-section">
        <div class="section-head">
          <h2>Lists</h2>
          <button class="ghost-button" data-action="openNewList">${icon("plus")} New</button>
        </div>
        ${state.composingList ? newListComposer() : ""}
        ${state.lists.length
          ? state.lists.map(listRail).join("")
          : `<p class="section-empty">Curated rows of titles. Tap any movie or show in Search or Queue to add it to a list.</p>`}
      </section>

      <section class="lib-section">
        <div class="section-head">
          <h2>Queue</h2>
        </div>
        <div class="field search-field">
          ${icon("search")}
          <input data-field="libraryQuery" value="${escapeAttr(state.libraryQuery)}" placeholder="Search saved titles" />
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
    </section>
  `;
}

function newListComposer() {
  return `
    <div class="new-list-row">
      <input data-new-list-name placeholder="List name" maxlength="80" autofocus />
      <button class="secondary-button" data-action="commitNewList">Add</button>
    </div>
  `;
}

function listRail(list) {
  const items = list.itemIds
    .map((id) => state.items.find((entry) => entry.id === id))
    .filter(Boolean);
  return `
    <section class="rail">
      <header class="rail-head">
        <h2>${escapeHtml(list.name)}</h2>
        <button class="rail-edit" data-edit-list="${escapeAttr(list.id)}" aria-label="Edit list">${icon("more")}</button>
      </header>
      ${items.length
        ? `<div class="rail-track">${items.map((item) => railCard(item)).join("")}</div>`
        : `<p class="rail-empty">Empty list. Tap a title and add it here.</p>`}
    </section>
  `;
}

function railCard(item) {
  return `
    <button class="rail-card" data-open="${escapeAttr(item.id)}" aria-label="${escapeAttr(item.title)}">
      ${poster(item)}
    </button>
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
      <section class="panel">
        <p class="panel-row"><strong>App version</strong><span class="help">Refresh cached app files without losing your saved titles or settings.</span></p>
        <button class="primary-button full-button" data-action="checkUpdate" ${state.updating ? "disabled" : ""}>${icon("refresh")} ${state.updating ? "Updating..." : "Check for update"}</button>
      </section>
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

function queueCard(item) {
  return `
    <article class="queue-card" data-open="${escapeAttr(item.id)}">
      ${poster(item)}
      <div class="queue-card-body">
        <div class="media-title">${escapeHtml(item.title)}</div>
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
  const inLibrary = state.items.some((entry) => entry.id === saved.id);
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
      ${inLibrary ? listPicker(saved) : ""}
      <label class="label" for="notes">Notes</label>
      <textarea id="notes" data-notes="${escapeAttr(saved.id)}" placeholder="Private notes">${escapeHtml(saved.notes || "")}</textarea>
      <div class="sheet-actions">
        ${inLibrary ? `<button class="danger-button" data-delete="${escapeAttr(saved.id)}">Remove</button>` : ""}
        <button class="primary-button" data-save-detail="${escapeAttr(saved.id)}">${inLibrary ? "Save" : "Add to queue"}</button>
      </div>
    </aside>
  `;
}

function listPicker(item) {
  return `
    <div class="control-group">
      <span class="label">Lists</span>
      <div class="list-pills">
        ${state.lists
          .map((list) => {
            const active = list.itemIds.includes(item.id);
            return `<button class="list-pill ${active ? "active" : ""}" data-toggle-list="${escapeAttr(list.id)}" data-toggle-item="${escapeAttr(item.id)}">${escapeHtml(list.name)}</button>`;
          })
          .join("")}
      </div>
      <div class="new-list-row">
        <input data-new-list-name placeholder="New list name" maxlength="80" />
        <button class="secondary-button" data-create-list="${escapeAttr(item.id)}">${icon("plus")} Create</button>
      </div>
    </div>
  `;
}

function listEditorSheet() {
  const list = state.lists.find((entry) => entry.id === state.editingListId);
  if (!list) return "";
  return `
    <div class="scrim" data-action="closeListEditor"></div>
    <aside class="sheet">
      <div class="grabber"></div>
      <p class="eyebrow">List · ${list.itemIds.length} titles</p>
      <label class="label" for="list-name-edit">Name</label>
      <input id="list-name-edit" class="text-input" data-list-name-edit value="${escapeAttr(list.name)}" maxlength="80" />
      <div class="sheet-actions">
        <button class="danger-button" data-delete-list="${escapeAttr(list.id)}">${icon("trash")} Delete</button>
        <button class="primary-button" data-save-list="${escapeAttr(list.id)}">Save</button>
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
      ${tab("library", "list", "Library")}
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
      if (!item) return;
      if (state.tab === "library") {
        deleteItem(item.id);
        return;
      }
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
  app.querySelector("[data-action='openNewList']")?.addEventListener("click", () => setState({ composingList: !state.composingList }));
  app.querySelector("[data-action='commitNewList']")?.addEventListener("click", () => {
    const input = app.querySelector("[data-new-list-name]");
    const list = createList(input?.value || "");
    if (!list) {
      toast("Name required");
      return;
    }
    state.composingList = false;
    toast(`Created ${list.name}`);
    render();
  });
  app.querySelectorAll("[data-edit-list]").forEach((button) =>
    button.addEventListener("click", () => setState({ editingListId: button.dataset.editList }))
  );
  app.querySelectorAll("[data-toggle-list]").forEach((button) =>
    button.addEventListener("click", () => {
      toggleItemInList(button.dataset.toggleList, button.dataset.toggleItem);
      render();
    })
  );
  app.querySelector("[data-create-list]")?.addEventListener("click", (event) => {
    const itemId = event.currentTarget.dataset.createList;
    const input = app.querySelector("[data-new-list-name]");
    const list = createList(input?.value || "");
    if (!list) {
      toast("Name required");
      return;
    }
    toggleItemInList(list.id, itemId);
    if (input) input.value = "";
    toast(`Created ${list.name}`);
    render();
  });
  app.querySelector("[data-save-list]")?.addEventListener("click", (event) => {
    const id = event.currentTarget.dataset.saveList;
    const name = app.querySelector("[data-list-name-edit]")?.value || "";
    renameList(id, name);
    setState({ editingListId: null });
  });
  app.querySelector("[data-delete-list]")?.addEventListener("click", (event) => {
    if (confirm("Delete this list? Titles stay in your library.")) {
      deleteList(event.currentTarget.dataset.deleteList);
      setState({ editingListId: null });
      toast("List deleted");
    }
  });
  app.querySelectorAll("[data-action='closeListEditor']").forEach((el) =>
    el.addEventListener("click", () => setState({ editingListId: null }))
  );
  app.querySelector("[data-action='checkUpdate']")?.addEventListener("click", checkForUpdate);
  app.querySelector("[data-action='export']")?.addEventListener("click", exportBackup);
  app.querySelector("[data-action='import']")?.addEventListener("change", importBackup);
  app.querySelector("[data-action='importPaste']")?.addEventListener("click", importPastedList);
  app.querySelector("[data-action='clear']")?.addEventListener("click", () => {
    if (confirm("Clear all saved titles and lists from this browser?")) {
      state.items = [];
      state.lists = [];
      KeepStore.saveItems();
      KeepStore.saveLists();
      toast("Library cleared");
      render();
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

async function checkForUpdate() {
  if (state.updating) return;
  setState({ updating: true });
  toast("Refreshing app...");
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    }
    window.setTimeout(() => location.reload(), 500);
  } catch (error) {
    setState({ updating: false });
    toast(`Update failed: ${error.message}`);
  }
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
    ,more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>'
    ,trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7"/><path d="M10 11v6M14 11v6"/></svg>'
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
