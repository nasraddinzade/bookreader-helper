// Распознавание речи на этом компьютере: Vosk (Kaldi) в WebAssembly, прямо в браузере.
// Звук никуда не отправляется. Модель (~40 МБ) раздаёт локальный сервер.
//
// Для чтения вслух один поток звука подаётся сразу в два распознавателя:
//   «по тексту» — грамматика из слов абзаца: хорошо следит, где читающий, но может «притянуть»
//                 неверно прочитанное слово к тексту (тогда у слова низкая уверенность) или дать [unk];
//   «свободный» — обычная модель с языковой моделью: слышит, что сказано на самом деле.

import { createModel } from 'vosk-browser';

const MODEL_URL = '/api/models/vosk/vosk-model-small-en-us-0.15.tar.gz';
let modelPromise = null;

export function loadSpeechModel() {
  if (!modelPromise) {
    modelPromise = createModel(MODEL_URL).catch((e) => {
      modelPromise = null;
      throw e;
    });
  }
  return modelPromise;
}

/**
 * Слушает микрофон (или audio — ArrayBuffer с записью, для проверки без голоса) и кормит
 * звуком все распознаватели из recognizers: [{ grammar, onPartial(text), onFinal({ text, result }) }].
 * result — слова с уверенностью и временем: [{ word, conf, start, end }] (секунды от начала).
 * onLevel(0..1) — громкость, для индикатора микрофона.
 * Возвращает { stop(), ended } — ended завершается, когда кончилась запись (только для audio).
 */
export async function startListening({ recognizers, audio, onLevel }) {
  const model = await loadSpeechModel();
  const ctx = new AudioContext();
  const recs = recognizers.map((r) => {
    const rec = new model.KaldiRecognizer(ctx.sampleRate, r.grammar?.length ? JSON.stringify(r.grammar) : undefined);
    rec.setWords(true);
    rec.on('partialresult', (m) => r.onPartial?.(m.result?.partial || ''));
    rec.on('result', (m) => r.onFinal?.(m.result || { text: '', result: [] }));
    return rec;
  });

  let source;
  let stream = null;
  let ended = null;
  if (audio) {
    source = ctx.createBufferSource();
    source.buffer = await ctx.decodeAudioData(audio);
    ended = new Promise((resolve) => { source.onended = resolve; });
    source.start();
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    source = ctx.createMediaStreamSource(stream);
  }
  // ScriptProcessor устарел, но его использует vosk-browser и он есть во всех Chromium.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    for (const rec of recs) {
      try { rec.acceptWaveform(e.inputBuffer); } catch { /* распознаватель уже остановлен */ }
    }
    if (onLevel) {
      const d = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < d.length; i += 16) sum += d[i] * d[i];
      onLevel(Math.min(1, Math.sqrt(sum / (d.length / 16)) * 6));
    }
  };
  source.connect(proc);
  proc.connect(ctx.destination); // без этого обработчик не вызывается; выход — тишина

  let stopped = false;
  return {
    ended,
    stop() {
      if (stopped) return;
      stopped = true;
      try { source.disconnect(); proc.disconnect(); } catch { /* уже отключено */ }
      stream?.getTracks().forEach((t) => t.stop());
      for (const rec of recs) { try { rec.remove(); } catch { /* уже удалён */ } }
      ctx.close().catch(() => {});
    },
  };
}
