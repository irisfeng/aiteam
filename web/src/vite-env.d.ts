/// <reference types="vite/client" />

interface Window {
  aiteamDesktop?: {
    notify(payload: { title: string; body: string; target?: string }): void;
    pickFile(mode: "source" | "template"): Promise<
      | { canceled: true }
      | { canceled: false; file: { name: string; size: number; bytes: number[] } }
    >;
  };
}
