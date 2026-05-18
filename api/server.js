import app from "../server/index.js";

export const config = {
  runtime: "nodejs"
};

function rewriteRequestUrl(request) {
  const host = request.headers.host || "localhost";
  const current = new URL(request.url, `http://${host}`);
  const pathnameOverride = current.searchParams.get("__pathname");

  if (!pathnameOverride) {
    return;
  }

  current.searchParams.delete("__pathname");
  request.url = `${pathnameOverride}${current.searchParams.toString() ? `?${current.searchParams.toString()}` : ""}`;
}

export default function handler(request, response) {
  rewriteRequestUrl(request);
  return app(request, response);
}
