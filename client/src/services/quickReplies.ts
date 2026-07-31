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
    console.error("[quickReplies] network error", url, err);
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // eslint-disable-next-line no-console
    console.error("[quickReplies] HTTP", res.status, url, body);
    throw new Error(`${res.status} ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export type QuickReply = {
  id: string;
  shortcut: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

export const listQuickReplies = () =>
  http<{ replies: QuickReply[] }>(`/api/quick-replies`).then((r) => r.replies ?? []);

export const createQuickReply = (shortcut: string, text: string) =>
  http<{ reply: QuickReply }>(`/api/quick-replies`, {
    method: "POST",
    body: JSON.stringify({ shortcut, text }),
  }).then((r) => r.reply);

export const updateQuickReply = (id: string, shortcut: string, text: string) =>
  http<{ reply: QuickReply }>(`/api/quick-replies/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ shortcut, text }),
  }).then((r) => r.reply);

export const deleteQuickReply = (id: string) =>
  http<void>(`/api/quick-replies/${encodeURIComponent(id)}`, { method: "DELETE" });
