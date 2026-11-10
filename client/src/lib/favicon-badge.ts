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

// ---- Som de notificação -------------------------------------------------
// Um ÚNICO AudioContext reaproveitado e "destravado" no primeiro clique/tecla
// do usuário. Antes, cada aviso criava um contexto novo; com a aba em segundo
// plano o navegador podia deixá-lo suspenso (sem gesto do usuário), e o som
// simplesmente não tocava.
type WithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext };

let sharedCtx: AudioContext | null = null;
let unlockInstalled = false;
let lastBeepAt = 0;

const getCtx = (): AudioContext | null => {
  if (sharedCtx) return sharedCtx;
  const Ctor = window.AudioContext || (window as WithWebkit).webkitAudioContext;
  if (!Ctor) return null;
  try {
    sharedCtx = new Ctor();
  } catch {
    return null;
  }
  return sharedCtx;
};

// Instala (uma vez) o "destravador": no primeiro gesto do usuário, cria e
// retoma o contexto de áudio, que depois segue funcionando em segundo plano.
export const installAudioUnlock = (): void => {
  if (unlockInstalled || typeof window === "undefined") return;
  unlockInstalled = true;
  const unlock = () => {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
};

// Som curto de notificação (dois beeps), sintetizado via WebAudio — mesmo
// padrão já usado no toque de chamada recebida (IncomingCallModal).
export const playNotificationSound = (): void => {
  // Anti-rajada: várias mensagens em sequência tocam um único aviso.
  const now = Date.now();
  if (now - lastBeepAt < 1200) return;
  lastBeepAt = now;
  try {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    const beep = (freq: number, start: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(0.2, t0 + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.05);
    };
    beep(720, 0, 0.12);
    beep(880, 0.14, 0.12);
  } catch {
    /* som é cosmético — nunca deve quebrar a UI */
  }
};
