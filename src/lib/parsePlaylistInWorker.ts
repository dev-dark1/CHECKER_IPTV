import type { PlaylistParseRequest, PlaylistParseResult } from "../player/types";

export function parsePlaylistInWorker(payload: PlaylistParseRequest) {
  return new Promise<PlaylistParseResult>((resolve, reject) => {
    const worker = new Worker(new URL("../workers/m3uParser.worker.ts", import.meta.url), {
      type: "module"
    });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    worker.onmessage = (event) => {
      if (event.data?.id === id) {
        resolve(event.data.result as PlaylistParseResult);
        worker.terminate();
      }
    };

    worker.onerror = (error) => {
      reject(error);
      worker.terminate();
    };

    worker.postMessage({ id, payload });
  });
}
