const STORAGE_KEY = "keep.media.v1";
const SETTINGS_KEY = "keep.settings.v1";
const LISTS_KEY = "keep.lists.v1";
const LANDING_KEY = "keep.landing.dismissed.v1";
const TASTE_KEY = "keep.taste.v1";
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
  updating: false,
  showLanding: false
};

const $ = (selector) => document.querySelector(selector);
const app = $("#app");

function initialTab() {
  const hashTab = location.hash.replace("#", "");
  const aliased = TAB_ALIASES[hashTab] || hashTab;
  return tabs.has(aliased) ? aliased : "home";
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function shouldShowLanding() {
  if (isStandalone()) return false;
  if (location.hash) return false;
  if (localStorage.getItem(LANDING_KEY) === "1") return false;
  if (state.items.length > 0 || state.settings.tmdbApiKey) return false;
  return true;
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
    state.homeResults = [];
    invalidateProfile();
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
    genreIds: Array.isArray(item.genreIds) ? item.genreIds.slice(0, 12).map(Number).filter(Number.isFinite) : [],
    language: item.language || "",
    status: ["queued", "watching", "watched"].includes(item.status) ? item.status : "queued",
    reaction: ["love", "like", "dislike"].includes(item.reaction) ? item.reaction : null,
    notes: item.notes || "",
    createdAt: item.createdAt || stamped,
    updatedAt: item.updatedAt || stamped
  };
}

let tasteCache = safeParse(localStorage.getItem(TASTE_KEY), {});

function saveTasteCache() {
  try {
    localStorage.setItem(TASTE_KEY, JSON.stringify(tasteCache));
  } catch {
    tasteCache = {};
  }
}

async function mapPool(items, size, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
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
    const url = new URL(`https://api.themoviedb.org/3/${resolved.type}/${resolved.sourceId}/recommendations`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("page", String(page));
    const response = await fetch(url);
    if (!response.ok) throw new Error("Discovery feed failed. Try again.");
    const data = await response.json();
    return (data.results || []).map((result) => mapTmdb(result, resolved.type));
  },
  async discover(type, params, page = 1) {
    const key = state.settings.tmdbApiKey.trim();
    if (!key) throw new Error("Add a TMDB API key in Settings to build your discovery feed.");
    const url = new URL(`https://api.themoviedb.org/3/discover/${type}`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("page", String(page));
    Object.entries(params).forEach(([name, value]) => url.searchParams.set(name, String(value)));
    const response = await fetch(url);
    if (!response.ok) throw new Error("Discovery feed failed. Try again.");
    const data = await response.json();
    return (data.results || []).map((result) => mapTmdb(result, type));
  },
  async metadata(item) {
    if (item.source !== "tmdb" || (item.type !== "movie" && item.type !== "tv")) return null;
    const cached = tasteCache[item.id];
    if (cached) return cached;
    const key = state.settings.tmdbApiKey.trim();
    if (!key) return null;
    const url = new URL(`https://api.themoviedb.org/3/${item.type}/${item.sourceId}`);
    url.searchParams.set("api_key", key);
    url.searchParams.set("append_to_response", "keywords,credits");
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    const rawKeywords = data.keywords?.keywords || data.keywords?.results || [];
    const crew = data.credits?.crew || [];
    const authors = crew
      .filter((person) => person.job === "Director" || person.job === "Screenplay" || person.job === "Writer" || person.job === "Creator")
      .map((person) => person.id);
    const date = data.release_date || data.first_air_date || "";
    const entry = {
      genres: (data.genres || []).map((genre) => genre.id),
      keywords: rawKeywords.map((keyword) => keyword.id).slice(0, 30),
      authors: [...new Set(authors)].slice(0, 4),
      cast: (data.credits?.cast || []).slice(0, 6).map((person) => person.id),
      decade: date ? Math.floor(Number(date.slice(0, 4)) / 10) * 10 : 0,
      language: data.original_language || "",
      popularity: Number(data.popularity || 0),
      voteAverage: Number(data.vote_average || 0)
    };
    tasteCache[item.id] = entry;
    saveTasteCache();
    return entry;
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
    genreIds: result.genre_ids || (result.genres || []).map((genre) => genre.id),
    language: result.original_language || "",
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
  invalidateProfile();
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
  invalidateProfile();
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

const SEARCH_DEBOUNCE_MS = 280;
let searchTimer = 0;
let searchToken = 0;

// Search runs on every keystroke now, so each request carries a token; only the
// newest one is allowed to write results back.
function scheduleSearch({ immediate = false } = {}) {
  window.clearTimeout(searchTimer);
  const query = state.searchQuery.trim();
  if (!query) {
    searchToken += 1;
    setState({ searchResults: [], searchError: "", searchLoading: false });
    return;
  }
  if (query.length < 2) return;
  searchTimer = window.setTimeout(runSearch, immediate ? 0 : SEARCH_DEBOUNCE_MS);
}

async function runSearch() {
  const query = state.searchQuery.trim();
  if (!query) return;
  searchToken += 1;
  const token = searchToken;
  setState({ searchLoading: true, searchError: "", searchResults: [] });
  try {
    const searches = [];
    if (state.searchType !== "anime") searches.push(TmdbApi.search(query, state.searchType));
    if (state.searchType === "anime") searches.push(JikanApi.search(query));
    const settled = await Promise.allSettled(searches);
    if (token !== searchToken) return;
    const results = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const errors = settled.filter((result) => result.status === "rejected");
    setState({
      searchResults: rankResults(results, query),
      searchError: results.length ? "" : errors[0]?.reason?.message || "No results found.",
      searchLoading: false
    });
  } catch (error) {
    if (token !== searchToken) return;
    setState({ searchError: error.message, searchLoading: false });
  }
}

const LIBRARY_DEBOUNCE_MS = 140;
let libraryTimer = 0;
function scheduleLibraryFilter() {
  window.clearTimeout(libraryTimer);
  libraryTimer = window.setTimeout(render, LIBRARY_DEBOUNCE_MS);
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
    invalidateProfile();
    state.homePage = 0;
    state.homeHasMore = true;
    state.homeError = "";
  }
  if (!state.homeResults.length) await loadHomeResults(false);
}

async function loadHomeResults(append) {
  if (state.homeLoading || (append && !state.homeHasMore)) return;
  if (!rankedSeeds().length) {
    setState({ homeResults: [], homeError: "", homeHasMore: false });
    return;
  }
  const nextPage = append ? state.homePage + 1 : 1;
  setState({ homeLoading: true, homeError: append ? state.homeError : "" });
  try {
    const profile = await tasteProfile();
    if (!profile) {
      setState({ homeResults: [], homeError: "", homeHasMore: false, homeLoading: false });
      return;
    }
    const { entries, error } = await gatherCandidates(profile, nextPage);
    const savedIds = new Set(state.items.map((item) => item.id));
    const savedTitles = new Set(state.items.map((item) => compactText(item.title)));
    const existingIds = new Set(append ? state.homeResults.map((item) => item.id) : []);
    const ranked = entries
      .filter((entry) => !savedIds.has(entry.item.id) && !existingIds.has(entry.item.id) && !savedTitles.has(compactText(entry.item.title)))
      .filter((entry) => isUsefulRecommendation(entry.item))
      .map((entry) => ({ ...entry, score: candidateScore(entry, profile) }))
      .sort((a, b) => b.score - a.score);
    const batch = diversify(ranked).map((entry) => entry.item);
    const next = append ? [...state.homeResults, ...batch] : batch;
    setState({
      homeResults: next,
      homePage: nextPage,
      homeHasMore: batch.length > 0 && nextPage < 6,
      homeError: next.length ? "" : error || "No recommendations yet.",
      homeLoading: false
    });
  } catch (error) {
    setState({ homeError: error.message, homeLoading: false, homeHasMore: false });
  }
}

let cachedProfile = null;
let cachedProfilePromise = null;

function invalidateProfile() {
  cachedProfile = null;
  cachedProfilePromise = null;
}

function tasteProfile() {
  if (cachedProfile) return Promise.resolve(cachedProfile);
  if (!cachedProfilePromise) {
    cachedProfilePromise = buildTasteProfile()
      .then((profile) => {
        cachedProfile = profile;
        return profile;
      })
      .finally(() => {
        cachedProfilePromise = null;
      });
  }
  return cachedProfilePromise;
}

// Reads the library's TMDB metadata (genres, keywords, directors, decade, language)
// and turns it into weighted preference maps. Recommendations are scored against
// this profile instead of against raw popularity.
async function buildTasteProfile() {
  const library = rankedSeeds().filter((item) => item.source === "tmdb");
  if (!library.length) return null;
  const sample = library.slice(0, 40);
  const pairs = await mapPool(sample, 6, async (item) => ({
    item,
    meta: await TmdbApi.metadata(item).catch(() => null)
  }));
  const withMeta = pairs.filter((pair) => pair.meta);
  if (!withMeta.length) return null;

  const genres = new Map();
  const keywords = new Map();
  const people = new Map();
  const decades = new Map();
  const languages = new Map();
  const avoidGenres = new Map();
  const avoidKeywords = new Set();
  const popularities = [];
  let tvWeight = 0;
  let totalWeight = 0;

  const bump = (map, key, amount) => {
    if (key === undefined || key === null || key === "") return;
    map.set(key, (map.get(key) || 0) + amount);
  };

  withMeta.forEach(({ item, meta }) => {
    const weight = tasteWeight(item);
    if (weight < 0) {
      meta.genres.forEach((id) => bump(avoidGenres, id, -weight));
      meta.keywords.forEach((id) => avoidKeywords.add(id));
      return;
    }
    totalWeight += weight;
    if (item.type === "tv") tvWeight += weight;
    popularities.push(Number(meta.popularity || item.popularity || 0));
    meta.genres.forEach((id) => bump(genres, id, weight));
    // Keywords are the sharpest taste signal TMDB exposes — "neo-noir", "cyberpunk",
    // "coming of age" separate this library from the blockbusters that share its genres.
    meta.keywords.forEach((id, index) => bump(keywords, id, weight * (index < 10 ? 1 : 0.5)));
    meta.authors.forEach((id) => bump(people, id, weight * 1.6));
    meta.cast.forEach((id, index) => bump(people, id, weight * (index < 3 ? 0.7 : 0.35)));
    bump(decades, meta.decade, weight);
    bump(languages, meta.language, weight);
  });

  if (!totalWeight) return null;

  return {
    genres: normalizeMap(genres),
    keywords: normalizeMap(keywords),
    people: normalizeMap(people),
    decades: normalizeMap(decades),
    languages: normalizeMap(languages),
    avoidGenres: normalizeMap(avoidGenres),
    avoidKeywords,
    keywordClusters: clusterKeywords(keywords),
    popularityAnchor: median(popularities),
    tvShare: tvWeight / totalWeight,
    seeds: library.slice(0, 10)
  };
}

function tasteWeight(item) {
  const reaction = { love: 3, like: 2, dislike: -2 }[item.reaction] ?? 1;
  if (reaction < 0) return reaction;
  const status = { watched: 1.25, watching: 1.15, queued: 1 }[item.status] || 1;
  return reaction * status;
}

function normalizeMap(map) {
  const max = Math.max(...map.values(), 0);
  if (!max) return new Map();
  return new Map([...map.entries()].map(([key, value]) => [key, value / max]));
}

function median(values) {
  if (!values.length) return 10;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function topKeys(map, count) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key]) => key);
}

// Groups the strongest keywords into OR-queries so /discover returns titles that
// share several signature traits rather than one broad genre.
function clusterKeywords(keywords) {
  const ranked = [...keywords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  const clusters = [];
  for (let index = 0; index < ranked.length; index += 3) {
    const slice = ranked.slice(index, index + 3);
    if (!slice.length) break;
    clusters.push({
      ids: slice.map(([id]) => id),
      weight: slice.reduce((sum, [, value]) => sum + value, 0) / slice.length
    });
  }
  return clusters;
}

// Candidates come from four generators. Each one stamps the candidate with the
// weight of the signal that produced it, so provenance survives into scoring.
async function gatherCandidates(profile, page) {
  const requests = [];
  const wantsTv = profile.tvShare > 0.15;
  const avoid = topKeys(profile.avoidGenres, 3).join(",");
  const baseParams = { "vote_count.gte": 60, "vote_average.gte": 5.8 };
  if (avoid) baseParams.without_genres = avoid;

  profile.keywordClusters.forEach((cluster, index) => {
    requests.push({
      source: `keyword:${cluster.ids.join("|")}`,
      weight: 220 * cluster.weight,
      run: () =>
        TmdbApi.discover(
          index % 2 === 0 || !wantsTv ? "movie" : "tv",
          { ...baseParams, with_keywords: cluster.ids.join("|"), sort_by: "vote_average.desc", "vote_count.gte": 120 },
          page
        )
    });
  });

  const topGenres = topKeys(profile.genres, 4);
  if (topGenres.length >= 2) {
    requests.push({
      source: `genres:${topGenres[0]},${topGenres[1]}`,
      weight: 120,
      run: () => TmdbApi.discover("movie", { ...baseParams, with_genres: `${topGenres[0]},${topGenres[1]}`, sort_by: "vote_average.desc", "vote_count.gte": 150 }, page)
    });
  }
  if (topGenres.length) {
    requests.push({
      source: `genres:${topGenres.join("|")}`,
      weight: 80,
      run: () => TmdbApi.discover(wantsTv ? "tv" : "movie", { ...baseParams, with_genres: topGenres.join("|"), sort_by: "popularity.desc" }, page)
    });
  }

  const topPeople = topKeys(profile.people, 4);
  if (topPeople.length) {
    requests.push({
      source: `people:${topPeople.join("|")}`,
      weight: 200,
      run: () => TmdbApi.discover("movie", { ...baseParams, with_people: topPeople.join("|"), sort_by: "vote_average.desc", "vote_count.gte": 40 }, page)
    });
  }

  // TMDB's per-title /recommendations is co-save behaviour, not taste — useful on the
  // first pages, pure noise deeper in, so it is capped and weighted below discovery.
  if (page <= 2) {
    profile.seeds.forEach((seed, index) => {
      requests.push({
        source: `seed:${seed.id}`,
        weight: 90 + (10 - index) * 6,
        run: () => TmdbApi.recommendations(seed, page)
      });
    });
  }

  const settled = await Promise.allSettled(requests.map((request) => request.run().then((items) => ({ request, items }))));
  const entries = new Map();
  settled.forEach((result) => {
    if (result.status !== "fulfilled") return;
    const { request, items } = result.value;
    items.forEach((item, index) => {
      const rankDecay = 1 - Math.min(index, 19) / 28;
      const current = entries.get(item.id) || { item, provenance: 0, sources: new Set(), primarySource: request.source, best: 0 };
      current.provenance += request.weight * rankDecay;
      current.sources.add(request.source);
      if (request.weight > current.best) {
        current.best = request.weight;
        current.primarySource = request.source;
      }
      entries.set(item.id, current);
    });
  });
  const error = settled.find((result) => result.status === "rejected")?.reason?.message || "";
  return { entries: [...entries.values()], error };
}

function candidateScore(entry, profile) {
  const item = entry.item;
  let score = entry.provenance;
  // Turning up from two independent signals is the strongest evidence available.
  if (entry.sources.size > 1) score += (entry.sources.size - 1) * 70;
  score += affinity(item.genreIds, profile.genres) * 150;
  score -= affinity(item.genreIds, profile.avoidGenres) * 240;
  score += (profile.languages.get(item.language) || 0) * 50;
  const decade = item.year ? Math.floor(Number(item.year) / 10) * 10 : 0;
  score += (profile.decades.get(decade) || 0) * 55;
  const votes = Number(item.voteCount || 0);
  if (votes >= 60) score += (Number(item.voteAverage || 0) - 6.2) * 24;
  score += popularityFit(item.popularity, profile.popularityAnchor);
  return score;
}

function affinity(genreIds, map) {
  if (!genreIds?.length || !map.size) return 0;
  const total = genreIds.reduce((sum, id) => sum + (map.get(id) || 0), 0);
  return total / genreIds.length;
}

// The core correction. A library of obscure titles should not be answered with
// blockbusters, so distance from the library's own popularity band is a penalty —
// asymmetric, because "too mainstream" is the failure mode being fixed.
function popularityFit(popularity, anchor) {
  const value = Math.log10(Math.max(Number(popularity) || 0, 0.5) + 1);
  const target = Math.log10(Math.max(Number(anchor) || 0, 0.5) + 1);
  const delta = value - target;
  if (delta > 0) return -Math.min(delta, 1.6) * 150;
  return -Math.min(-delta, 1.6) * 55;
}

// Keeps one loud seed or one genre from swallowing the grid. This is a decay rather
// than a hard cap: a repeated source is nudged down, never demoted below a title the
// profile scored far lower. Entries must already be sorted by score.
function diversify(entries) {
  const perSource = new Map();
  const perGenre = new Map();
  return entries
    .map((entry) => {
      const genre = entry.item.genreIds?.[0] ?? "none";
      const sourceCount = perSource.get(entry.primarySource) || 0;
      const genreCount = perGenre.get(genre) || 0;
      perSource.set(entry.primarySource, sourceCount + 1);
      perGenre.set(genre, genreCount + 1);
      return { ...entry, score: entry.score - sourceCount * 20 - genreCount * 12 };
    })
    .sort((a, b) => b.score - a.score);
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
    .filter((item) => (item.type === "movie" || item.type === "tv") && item.reaction !== "dislike")
    .sort((a, b) => seedWeight(b) - seedWeight(a) || new Date(b.updatedAt) - new Date(a.updatedAt));
}

// Popularity used to rank seeds too, which meant the feed was grown from the most
// mainstream saves. Ranking is now reaction, status, then recency.
function seedWeight(item) {
  const reaction = { love: 70, like: 45 }[item.reaction] || 0;
  const status = { watched: 35, watching: 28, queued: 12 }[item.status] || 0;
  return reaction + status;
}

function isUsefulRecommendation(item) {
  if (!item.posterUrl || !item.overview) return false;
  // Unrated titles used to slip through; they are the bulk of /discover's tail.
  if (Number(item.voteCount || 0) < 40) return false;
  if (Number(item.voteAverage || 0) < 5.6) return false;
  return Number(item.popularity || 0) >= 0.4;
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

const animTracker = { tab: null, selectedId: null, pickId: null, editingListId: null, landing: null };

// innerHTML swaps destroy the focused input, which would drop the keyboard on every
// keystroke now that search is live. Capture the caret before, restore it after.
function captureFocus() {
  const element = document.activeElement;
  if (!element || !app.contains(element) || !element.dataset?.field) return null;
  return { field: element.dataset.field, start: element.selectionStart, end: element.selectionEnd };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  const element = app.querySelector(`[data-field="${CSS.escape(snapshot.field)}"]`);
  if (!element) return;
  element.focus({ preventScroll: true });
  try {
    element.setSelectionRange(snapshot.start, snapshot.end);
  } catch {
    /* selection ranges are unsupported on some input types */
  }
}

function render() {
  const focus = captureFocus();
  if (state.showLanding) {
    app.innerHTML = landingView();
    bindLandingEvents();
    runEnterAnimations();
    homeObserver?.disconnect();
    return;
  }
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
  restoreFocus(focus);
  runEnterAnimations();
  if (state.tab === "home") {
    refreshHome();
    attachHomeObserver();
  } else {
    homeObserver?.disconnect();
  }
}

function runEnterAnimations() {
  if (state.showLanding) {
    if (animTracker.landing !== true) {
      animTracker.landing = true;
      animateView();
    }
    return;
  }
  animTracker.landing = false;
  if (animTracker.tab !== state.tab) {
    animTracker.tab = state.tab;
    animateView();
  }
  const selectedId = state.selected?.id || null;
  if (selectedId && selectedId !== animTracker.selectedId) animateSheet();
  animTracker.selectedId = selectedId;
  const pickId = state.pick?.id || null;
  if (pickId && pickId !== animTracker.pickId) animateSheet();
  animTracker.pickId = pickId;
  if (state.editingListId && state.editingListId !== animTracker.editingListId) animateSheet();
  animTracker.editingListId = state.editingListId;
}

function animateView() {
  const view = app.querySelector(".view, .landing");
  view?.animate(
    [
      { opacity: 0, transform: "translateY(10px)" },
      { opacity: 1, transform: "translateY(0)" }
    ],
    { duration: 240, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" }
  );
}

function animateSheet() {
  const sheet = app.querySelector(".sheet");
  const scrim = app.querySelector(".scrim");
  scrim?.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { duration: 220, easing: "ease-out", fill: "backwards" }
  );
  sheet?.animate(
    [
      { opacity: 0, transform: "translateY(28px) scale(0.97)" },
      { opacity: 1, transform: "translateY(0) scale(1)" }
    ],
    { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" }
  );
}

function landingView() {
  return `
    <main class="landing">
      <section class="landing-hero">
        <img src="./icons/icon-192.svg" alt="" class="landing-icon" />
        <h1>Keep</h1>
        <p class="landing-tagline">Track the movies and shows you actually want to watch. Your library lives on your phone — no cloud, no account, no ads.</p>
        <button class="primary-button landing-cta" data-action="enterApp">Open Keep</button>
      </section>

      <section class="landing-step">
        <div class="step-num">1</div>
        <div class="step-body">
          <h2>Install it</h2>
          <p>In Safari, tap the <strong>Share</strong> icon, scroll to <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>. Keep opens like a real app — fullscreen, offline-ready.</p>
        </div>
      </section>

      <section class="landing-step">
        <div class="step-num">2</div>
        <div class="step-body">
          <h2>Grab a free TMDB key</h2>
          <p>Keep uses your own <a href="https://www.themoviedb.org/signup" target="_blank" rel="noreferrer">TMDB</a> key so searches stay private. Sign up free, open Settings → API on TMDB, paste the key into Keep → Settings.</p>
        </div>
      </section>

      <section class="landing-step">
        <div class="step-num">3</div>
        <div class="step-body">
          <h2>Build your library</h2>
          <p>Search anything, tap to save. Make curated lists like <em>Saturday horror</em> or <em>Date night</em>. Home fills with picks based on your queue and reactions.</p>
        </div>
      </section>

      <section class="landing-foot">
        <p>Everything stays on your device. Export a JSON backup any time from Settings.</p>
        <button class="primary-button landing-cta" data-action="enterApp">Open Keep</button>
        <p class="landing-fine">Works offline once installed · Free forever</p>
      </section>
    </main>
  `;
}

function bindLandingEvents() {
  app.querySelectorAll("[data-action='enterApp']").forEach((button) =>
    button.addEventListener("click", () => {
      localStorage.setItem(LANDING_KEY, "1");
      state.showLanding = false;
      render();
    })
  );
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
      <div class="field search-field">
        ${icon("search")}
        <input
          data-field="searchQuery"
          value="${escapeAttr(state.searchQuery)}"
          placeholder="Movie or show"
          type="search"
          autocomplete="off"
          autocapitalize="none"
          autocorrect="off"
          spellcheck="false"
          enterkeyhint="search"
          aria-label="Search movies and shows"
        />
        <button class="field-clear ${state.searchQuery ? "" : "is-hidden"}" data-action="clearSearch" aria-label="Clear search">${icon("close")}</button>
      </div>
      <details class="filter-drawer" data-filter-drawer="searchFiltersOpen" ${state.searchFiltersOpen ? "open" : ""}>
        <summary>${icon("filter")} Filters <span>${searchFilterLabel()}</span></summary>
        <div class="chip-row">${chips("searchType", ["all", "movie", "tv", "anime"])}</div>
      </details>
      ${!state.settings.tmdbApiKey && state.searchType !== "anime" ? setupPrompt() : ""}
      ${state.searchError ? `<div class="notice">${escapeHtml(state.searchError)}</div>` : ""}
      <div class="list">
        ${state.searchLoading ? searchSkeletons(5) : state.searchResults.map(searchCard).join("")}
      </div>
    </section>
  `;
}

function searchSkeletons(count) {
  const row = `
    <div class="media-row skeleton-row" aria-hidden="true">
      <div class="poster skel-block"></div>
      <div class="skel-body">
        <div class="skel-line skel-line-title"></div>
        <div class="skel-line skel-line-meta"></div>
        <div class="skel-line skel-line-summary"></div>
      </div>
    </div>
  `;
  return row.repeat(count);
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
        invalidateProfile();
        KeepStore.saveSettings();
      } else {
        state[field] = input.value;
        if (field === "searchQuery") {
          app.querySelector("[data-action='clearSearch']")?.classList.toggle("is-hidden", !input.value);
          scheduleSearch();
        }
        if (field === "libraryQuery") scheduleLibraryFilter();
      }
    });
    if (input.dataset.field === "searchQuery") {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          scheduleSearch({ immediate: true });
        }
      });
      input.addEventListener("search", () => scheduleSearch({ immediate: true }));
    }
  });
  app.querySelector("[data-action='clearSearch']")?.addEventListener("click", () => {
    state.searchQuery = "";
    scheduleSearch();
  });
  app.querySelector("[data-action='refreshHome']")?.addEventListener("click", () => refreshHome(true));
  app.querySelectorAll("[data-add]").forEach((button) => button.addEventListener("click", () => addFromSearch(state.searchResults.find((item) => item.id === button.dataset.add))));
  app.querySelectorAll("[data-add-home]").forEach((button) => button.addEventListener("click", () => addOrUpdate(state.homeResults.find((item) => item.id === button.dataset.addHome))));
  app.querySelectorAll("[data-preview]").forEach((button) => button.addEventListener("click", () => setState({ selected: state.searchResults.find((item) => item.id === button.dataset.preview) })));
  app.querySelectorAll("[data-preview-home]").forEach((button) => button.addEventListener("click", () => setState({ selected: state.homeResults.find((item) => item.id === button.dataset.previewHome) })));
  app.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => setState({ selected: state.items.find((item) => item.id === el.dataset.open), pick: null })));
  app.querySelectorAll("[data-action='close']").forEach((el) => el.addEventListener("click", () => setState({ selected: null })));
  app.querySelectorAll("[data-action='closePick']").forEach((el) => el.addEventListener("click", () => setState({ pick: null })));
  app.querySelectorAll("[data-action='pick']").forEach((el) => el.addEventListener("click", randomPick));
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
      state.homeResults = [];
      tasteCache = {};
      saveTasteCache();
      invalidateProfile();
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
  invalidateProfile();
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
    ,close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>'
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
state.showLanding = shouldShowLanding();
render();

window.addEventListener("hashchange", () => switchTab(initialTab()));

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
