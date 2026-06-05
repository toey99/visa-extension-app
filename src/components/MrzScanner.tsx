"use client";

import { useRef, useState } from "react";

export type MrzScanResult = {
  firstName: string;
  lastName: string;
  nationality: string;       // ICAO 3-letter
  documentNumber: string;
  sex?: "male" | "female" | "unspecified";
  birthDate?: string;        // YYMMDD
  expirationDate?: string;   // YYMMDD
};

export default function MrzScanner({
  onScan,
  onError,
}: {
  onScan: (data: MrzScanResult) => void;
  onError: (msg: string) => void;
}) {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    setScanning(true);
    setProgress(0);
    setStage("Loading OCR engine...");

    try {
      // Dynamic imports keep tesseract.js out of the initial JS bundle
      const [{ createWorker }, mrzModule] = await Promise.all([
        import("tesseract.js"),
        import("mrz"),
      ]);

      const worker = await createWorker("eng", 1, {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === "recognizing text") {
            setStage("Reading passport...");
            setProgress(Math.round(m.progress * 100));
          }
        },
      });

      // MRZ uses only A–Z, 0–9, and "<". Restricting the whitelist
      // dramatically improves accuracy and speed.
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<",
      });

      const { data } = await worker.recognize(file);
      await worker.terminate();

      setStage("Parsing MRZ...");

      // Look for the MRZ block: two consecutive lines of equal length
      // (44 chars for TD3 passports; 36 for TD2; 30 for TD1).
      const allLines = data.text
        .split("\n")
        .map((l) => l.replace(/\s/g, "").toUpperCase())
        .filter((l) => l.length >= 30);

      let mrzLines: string[] | null = null;
      for (let i = 0; i < allLines.length - 1; i++) {
        const a = allLines[i];
        const b = allLines[i + 1];
        if (a.length === b.length && [30, 36, 44].includes(a.length)) {
          mrzLines = [a, b];
          break;
        }
      }

      // Fallback: try the last two non-empty lines
      if (!mrzLines && allLines.length >= 2) {
        const tail = allLines.slice(-2);
        if (tail[0].length === tail[1].length) mrzLines = tail;
      }

      if (!mrzLines) {
        throw new Error(
          "Could not locate the MRZ region. Make sure the bottom two lines of your passport bio page are fully visible and in focus."
        );
      }

      const result = mrzModule.parse(mrzLines, { autocorrect: true });
      const f = result.fields;

      if (!f.firstName && !f.lastName && !f.documentNumber) {
        throw new Error(
          "MRZ characters were read but could not be parsed into fields. Please try a sharper image."
        );
      }

      onScan({
        firstName: (f.firstName || "").trim(),
        lastName: (f.lastName || "").trim(),
        nationality: (f.nationality || "").trim(),
        documentNumber: (f.documentNumber || "").trim(),
        sex: (f.sex as MrzScanResult["sex"]) || undefined,
        birthDate: f.birthDate || undefined,
        expirationDate: f.expirationDate || undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Passport scan failed.";
      onError(msg);
    } finally {
      setScanning(false);
      setProgress(0);
      setStage("");
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={scanning}
        className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
      >
        {scanning ? (
          <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 9V5a2 2 0 012-2h4M3 15v4a2 2 0 002 2h4M21 9V5a2 2 0 00-2-2h-4M21 15v4a2 2 0 01-2 2h-4" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
        {scanning ? `${stage} ${progress > 0 ? `${progress}%` : ""}` : "Scan Passport (MRZ)"}
      </button>
      {!scanning && (
        <p className="text-xs text-slate-500">
          Photo of the passport bio page — both MRZ lines must be visible.
        </p>
      )}
    </div>
  );
}
