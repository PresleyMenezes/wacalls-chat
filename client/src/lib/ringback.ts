// Gera o som de "chamando" (ringback) UMA VEZ, como um arquivo de áudio de
// verdade (WAV), em vez de tocar um tom "ao vivo" com AudioContext. Isso é
// proposital: um AudioContext ao vivo compete pelo mesmo hardware de áudio
// que a chamada usa pra captar o microfone, e já causou falha real de
// chamada numa tentativa anterior. Um arquivo de áudio tocado numa tag
// <audio> comum usa o pipeline de mídia do navegador, sem esse risco.
let cachedUrl: string | null = null;

const encodeWav = (samples: Float32Array, sampleRate: number): Blob => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
};

// Padrão clássico de "chamando" no Brasil: ~1s de tom, ~4s de silêncio,
// repetindo (a tag <audio loop> cuida da repetição sozinha).
export const getRingbackUrl = (): string => {
  if (cachedUrl) return cachedUrl;
  const sampleRate = 8000;
  const totalSeconds = 5;
  const toneSeconds = 1;
  const samples = new Float32Array(sampleRate * totalSeconds);
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    if (t < toneSeconds) {
      // fade-out suave no fim do tom, pra não estalar
      const fade = t > toneSeconds - 0.05 ? (toneSeconds - t) / 0.05 : 1;
      samples[i] = Math.sin(2 * Math.PI * 425 * t) * 0.25 * fade;
    } else {
      samples[i] = 0;
    }
  }
  const blob = encodeWav(samples, sampleRate);
  cachedUrl = URL.createObjectURL(blob);
  return cachedUrl;
};
