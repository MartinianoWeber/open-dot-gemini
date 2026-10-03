"use client";

// Speech-to-text for Antigravity dots. The browser listens; the composer shows the words.
// There is no call and no spoken reply.

type RecogResult = { isFinal: boolean; 0?: { transcript?: string } };
type RecogEvent = { results: ArrayLike<RecogResult> };
type RecogError = { error: string };
type Recog = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: RecogEvent) => void) | null;
  onerror: ((ev: RecogError) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
};

function recognitionCtor(): (new () => Recog) | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { SpeechRecognition?: new () => Recog; webkitSpeechRecognition?: new () => Recog };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Listen in es-AR and report the words said since start, including the phrase still in progress.
 * Returns a stop handle, or an error when this browser can't recognize speech.
 */
export function startDictation(onTranscript: (spoken: string) => void, onError: (message: string) => void): { stop: () => void } | { error: string } {
  const Ctor = recognitionCtor();
  if (!Ctor) return { error: "This browser can't recognize speech." };

  const recognition = new Ctor();
  recognition.lang = "es-AR";
  recognition.continuous = true;
  recognition.interimResults = true;
  let listening = true;

  const stop = () => {
    listening = false;
    try {
      recognition.abort();
    } catch {
      /* not started */
    }
  };

  recognition.onresult = (ev) => {
    if (!listening) return;
    let spoken = "";
    for (let i = 0; i < ev.results.length; i++) spoken += ev.results[i]?.[0]?.transcript ?? "";
    onTranscript(spoken);
  };
  recognition.onerror = (ev) => {
    if (!listening || ev.error === "aborted" || ev.error === "no-speech") return;
    const blocked = ev.error === "not-allowed" || ev.error === "service-not-allowed";
    onError(blocked ? "Microphone access was blocked." : "Speech recognition failed.");
    stop();
  };
  recognition.onend = () => {
    if (!listening) return;
    window.setTimeout(() => {
      if (!listening) return;
      try {
        recognition.start();
      } catch {
        /* already started */
      }
    }, 200);
  };

  try {
    recognition.start();
  } catch {
    return { error: "Speech recognition failed." };
  }
  return { stop };
}
