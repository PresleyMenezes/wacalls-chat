import React, { type ReactNode } from "react";

// Detecta URLs (http/https/www) dentro de um texto e retorna um array de
// nós React com os links convertidos em <a> clicáveis, preservando o texto
// ao redor. Usado nas bolhas de mensagem para tornar links recebidos
// clicáveis, como o WhatsApp faz nativamente.
const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[a-z]{2,}[^\s<>"']*)/gi;

export const linkifyText = (text: string): ReactNode[] => {
  if (!text) return [text];
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  let key = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    const [raw] = match;
    const start = match.index;
    if (start > lastIndex) {
      parts.push(text.slice(lastIndex, start));
    }
    // Trailing punctuation (.,;:!?)) frequently isn't part of the URL.
    let url = raw;
    let trailing = "";
    const trailingMatch = url.match(/[.,;:!?)\]]+$/);
    if (trailingMatch) {
      trailing = trailingMatch[0];
      url = url.slice(0, -trailing.length);
    }
    const href = url.startsWith("http") ? url : `https://${url}`;
    const linkKey = "lnk-" + key++;
    parts.push(
      React.createElement(
        "a",
        {
          key: linkKey,
          href: href,
          target: "_blank",
          rel: "noopener noreferrer",
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
          className: "underline underline-offset-2 hover:opacity-80",
        },
        url,
      ),
    );
    if (trailing) parts.push(trailing);
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
};
