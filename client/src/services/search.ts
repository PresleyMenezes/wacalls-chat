import { apiUrl } from "@/lib/api-base";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const url = apiUrl(path);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[search] network error", url, err);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // eslint-disable-next-line no-console
    console.error("[search] HTTP", res.status, url, body);
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

export type SearchResult = {
  sessionId: string;
  chatJid: string;
  chatName?: string;
  avatarUrl?: string;
  messageId: string;
  body: string;
  kind: string;
  ts: number;
  fromMe: boolean;
};

export const searchMessages = (query: string, limit = 50) =>
  http<{ results: SearchResult[] }>(
    `/api/search/messages?q=${encodeURIComponent(query)}&limit=${limit}`,
  ).then((r) => r.results ?? []);
