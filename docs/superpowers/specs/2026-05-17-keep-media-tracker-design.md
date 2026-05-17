# Keep Media Tracker Design

Date: 2026-05-17

## Goal

Build `Keep`, an iOS-friendly web app for tracking personal media across movies, TV shows, and anime. The app should clone the core personal tracking feel of Queue without social features: save media, manage a watch queue, mark simple progress status, and optionally leave personal ratings and notes.

The first version should be clean, minimal, fast on mobile Safari, and deployable as a static GitHub Pages site.

## Product Scope

V1 includes:

- Queue-first home screen.
- Search and add media from TMDB and Jikan.
- Three statuses: `queued`, `watching`, `watched`.
- Personal reaction: `love`, `like`, `dislike`, plus optional notes.
- Random pick button for queued items, with filters.
- Local-first data storage.
- JSON export/import backup.
- Settings for TMDB API key.
- Installable iOS PWA shell.
- GitHub Pages deployment setup.

V1 does not include:

- Accounts or authentication.
- Cloud sync.
- Social feeds, shared lists, or friend activity.
- Per-episode tracking.
- Paused/dropped statuses.
- Push reminders.

## UX Direction

Visual direction: `iOS Slate`.

The app should feel like a small native utility, not a landing page. The primary screen is a compact media list with poster thumbnails, title metadata, and quick status controls. Styling should use a light slate-tinted palette, subtle borders, careful spacing, and a bottom tab bar.

Navigation:

- `Queue`
- `Search`
- `Settings`

The Queue tab owns daily use. Search is for adding new media. Settings handles API key and backup.

## Screens

### Queue

Purpose: manage saved media quickly.

Elements:

- Header with app name and random pick control.
- Filter chips for status and type.
- Search-within-library field.
- Saved item list with poster, title, type/year, status, and reaction.
- Empty states for first run and filtered states.
- Detail/edit sheet for changing status, reaction, and notes.

Random pick:

- Chooses from saved items, defaulting to `queued`.
- Can respect current filters.
- Shows selected item in a lightweight modal/sheet.

### Search

Purpose: find and add media.

Elements:

- Search input.
- Type selector: Movies, TV, Anime, All.
- Results from TMDB for movies/TV and Jikan for anime.
- Quick `+ Queue` action on each result.
- Result detail view/sheet with metadata and save options.

Behavior:

- Quick add saves result with `queued` status.
- Detail save can choose status immediately.
- If TMDB key is missing, movie/TV search shows setup prompt; anime search can still work through Jikan.

### Settings

Purpose: configuration and backup.

Elements:

- TMDB API key input stored locally.
- Export JSON backup.
- Import JSON backup.
- Clear all local data, behind confirmation.
- PWA/install hint copy if needed.

## Data Model

Saved media item:

```ts
type MediaType = "movie" | "tv" | "anime";
type WatchStatus = "queued" | "watching" | "watched";
type Reaction = "love" | "like" | "dislike" | null;

type MediaItem = {
  id: string;
  source: "tmdb" | "jikan" | "manual";
  sourceId: string;
  type: MediaType;
  title: string;
  originalTitle?: string;
  year?: string;
  overview?: string;
  posterUrl?: string;
  status: WatchStatus;
  reaction: Reaction;
  notes: string;
  createdAt: string;
  updatedAt: string;
};
```

Settings:

```ts
type AppSettings = {
  tmdbApiKey: string;
};
```

Export format:

```ts
type KeepBackup = {
  version: 1;
  exportedAt: string;
  items: MediaItem[];
  settings?: Partial<AppSettings>;
};
```

## Architecture

Use a dependency-free static PWA. Keep service boundaries simple:

- `storage`: local persistence, import/export, migrations.
- `tmdb`: movie/TV search and detail mapping.
- `jikan`: anime search and detail mapping.
- `library`: item add/update/delete/filter logic.
- UI components for tabs, lists, chips, rating controls, sheets, and empty states.

Storage should start with `localStorage` unless payload size becomes an issue during implementation. Structure storage access behind a small adapter so IndexedDB can replace it later without changing UI code. The first version should avoid runtime dependencies so GitHub Pages deployment and offline loading stay simple.

## Error Handling

- Missing TMDB key: show clear settings prompt for movie/TV search.
- API failure: show non-blocking error state and allow retry.
- Duplicate add: update existing item or show existing status instead of adding duplicate.
- Import failure: validate JSON shape and show a readable error.
- Corrupt stored data: avoid crashing; preserve raw value where practical and start from empty library if needed.

## Deployment

Use `keep` as its own Git repository.

Deployment target:

- GitHub Pages.
- GitHub Actions build/deploy.
- No committed TMDB key.
- User enters TMDB key in Settings after opening deployed app.

## Testing And Verification

Manual acceptance:

- App loads on desktop and mobile viewport.
- Bottom tabs work.
- TMDB key can be saved locally.
- Movie/TV search works with key.
- Anime search works without TMDB key.
- Quick add creates queued item.
- Status can change among queued/watching/watched.
- Reaction can change among love/like/dislike/none.
- Notes persist.
- Random pick selects from queued items.
- Export creates valid JSON.
- Import restores saved items.
- GitHub Pages build succeeds.

Automated checks:

- TypeScript build.
- Basic unit tests for storage/import/export/filtering if test stack is added.
- Playwright smoke test if practical after implementation.
