import type { CachedPlaylist, PlayerSettings, RecentChannel } from "../player/types";

const DB_NAME = "iptv-player-local-cache";
const DB_VERSION = 1;
const PLAYLIST_STORE = "playlists";
const META_STORE = "meta";

const SETTINGS_KEY = "settings";
const FAVORITES_KEY = "favorites";
const HISTORY_KEY = "history";

const defaultSettings: PlayerSettings = {
  volume: 0.8,
  muted: false,
  lastPlaylistId: null,
  lastChannelId: null,
  lastSidebarView: "all"
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(PLAYLIST_STORE)) {
        db.createObjectStore(PLAYLIST_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => Promise<T>
) {
  const db = await openDatabase();

  try {
    return await run(db.transaction(storeNames, mode));
  } finally {
    db.close();
  }
}

export async function getAllPlaylistsFromDb() {
  return withTransaction([PLAYLIST_STORE], "readonly", async (transaction) => {
    const store = transaction.objectStore(PLAYLIST_STORE);
    const result = await requestToPromise(store.getAll());
    return (result as CachedPlaylist[]).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  });
}

export async function savePlaylistToDb(playlist: CachedPlaylist) {
  return withTransaction([PLAYLIST_STORE], "readwrite", async (transaction) => {
    await requestToPromise(transaction.objectStore(PLAYLIST_STORE).put(playlist));
  });
}

export async function deletePlaylistFromDb(id: string) {
  return withTransaction([PLAYLIST_STORE], "readwrite", async (transaction) => {
    await requestToPromise(transaction.objectStore(PLAYLIST_STORE).delete(id));
  });
}

async function getMetaValue<T>(key: string, fallback: T) {
  return withTransaction([META_STORE], "readonly", async (transaction) => {
    const record = await requestToPromise<{ key: string; value: T } | undefined>(
      transaction.objectStore(META_STORE).get(key)
    );
    return record?.value ?? fallback;
  });
}

async function setMetaValue<T>(key: string, value: T) {
  return withTransaction([META_STORE], "readwrite", async (transaction) => {
    await requestToPromise(transaction.objectStore(META_STORE).put({ key, value }));
  });
}

export async function getPlayerSettingsFromDb() {
  return getMetaValue<PlayerSettings>(SETTINGS_KEY, defaultSettings);
}

export async function savePlayerSettingsToDb(settings: PlayerSettings) {
  return setMetaValue(SETTINGS_KEY, settings);
}

export async function getFavoritesFromDb() {
  return getMetaValue<string[]>(FAVORITES_KEY, []);
}

export async function saveFavoritesToDb(favorites: string[]) {
  return setMetaValue(FAVORITES_KEY, favorites);
}

export async function getRecentChannelsFromDb() {
  return getMetaValue<RecentChannel[]>(HISTORY_KEY, []);
}

export async function saveRecentChannelsToDb(history: RecentChannel[]) {
  return setMetaValue(HISTORY_KEY, history.slice(0, 60));
}
