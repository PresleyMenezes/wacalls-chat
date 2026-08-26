// Buffer de tolerância a jitter de rede — bem menor que antes (2s), com um
// alvo de atraso curto. Sem isso, se o áudio chegar em rajadas mais rápido
// do que é tocado, o atraso só cresce e nunca volta a diminuir (o efeito de
// "câmera lenta" relatado em chamadas longas) — aqui, quando o acúmulo
// ultrapassa o alvo, descartamos as amostras mais antigas em excesso pra
// voltar perto do tempo real, em vez de deixar o atraso se acumular pra
// sempre.
const SAMPLE_RATE = 16000;
const RING_SIZE = SAMPLE_RATE * 1; // 1s de capacidade máxima (proteção contra estouro)
const TARGET_SAMPLES = Math.floor(SAMPLE_RATE * 0.12); // ~120ms de atraso alvo

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_SIZE);
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.port.onmessage = (e) => {
      const data = e.data;
      for (let i = 0; i < data.length; i += 1) {
        this.ring[this.write] = data[i];
        this.write = (this.write + 1) % RING_SIZE;
        if (this.available < RING_SIZE) {
          this.available += 1;
        } else {
          this.read = (this.read + 1) % RING_SIZE;
        }
      }
      // Se acumulamos muito mais que o alvo, avança a leitura pra "pular"
      // o excesso — evita que o atraso cresça indefinidamente.
      if (this.available > TARGET_SAMPLES * 2) {
        const drop = this.available - TARGET_SAMPLES;
        this.read = (this.read + drop) % RING_SIZE;
        this.available = TARGET_SAMPLES;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i += 1) {
      if (this.available > 0) {
        out[i] = this.ring[this.read];
        this.read = (this.read + 1) % RING_SIZE;
        this.available -= 1;
      } else {
        out[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
