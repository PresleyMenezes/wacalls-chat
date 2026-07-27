// Desenha uma bolinha vermelha de notificação sobre o favicon (estilo
// contador de não-lidas), atualizando dinamicamente o <link rel="icon">.
// Usa <canvas> para compor a imagem base + badge em tempo real.

let baseImg: HTMLImageElement | null = null;
let loading: Promise<HTMLImageElement> | null = null;

const loadBaseIcon = (): Promise<HTMLImageElement> => {
  if (baseImg) return Promise.resolve(baseImg);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      baseImg = img;
      resolve(img);
    };
    img.onerror = reject;
    img.src = "/favicon.png";
  });
  return loading;
};

export const updateFaviconBadge = async (hasUnread: boolean): Promise<void> => {
  try {
    const img = await loadBaseIcon();
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    if (hasUnread) {
      const r = size * 0.22;
      const cx = size - r - 2;
      const cy = r + 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = "#ef4444";
      ctx.fill();
      ctx.lineWidth = size * 0.035;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
    const dataUrl = canvas.toDataURL("image/png");
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/png";
    link.href = dataUrl;
  } catch {
    /* falha ao desenhar o badge não deve quebrar a UI */
  }
};

// Som curto de notificação (dois beeps), sintetizado via WebAudio — mesmo
// padrão já usado no toque de chamada recebida (IncomingCallModal).
export const playNotificationSound = (): void => {
  try {
    type WithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext || (window as WithWebkit).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
    };
    beep(720, 0, 0.12);
    beep(880, 0.14, 0.12);
    ctx.resume?.().catch(() => {});
    setTimeout(() => { try { ctx.close(); } catch { /* noop */ } }, 500);
  } catch {
    /* som é cosmético — nunca deve quebrar a UI */
  }
};
