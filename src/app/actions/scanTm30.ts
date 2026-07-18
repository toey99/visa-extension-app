"use server";

import { GoogleGenAI, Type } from "@google/genai";
import {
  classifyGeminiError,
  friendlyGeminiMessage,
  isTransientGeminiError,
} from "@/lib/geminiError";

export type AiTm30ScanResult = {
  houseNo: string;
  road: string;
  subDistrict: string;
  district: string;
  province: string;
  postalCode: string;
};

export type Tm30ScanResponse =
  | { ok: true; data: AiTm30ScanResult }
  | { ok: false; error: string };

const MAX_BYTES = 10 * 1024 * 1024;
const PDF_MIME = "application/pdf";
const MODEL = "gemini-2.5-flash";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const FILE_ACTIVE_TIMEOUT_MS = 30_000;
const FILE_POLL_INTERVAL_MS = 1000;

const PROMPT = `Analyze this Thai TM.30 Receipt of Notification PDF. Extract the resident's address in Thailand. Return EXCLUSIVELY a JSON object with these fields: { houseNo, road, subDistrict, district, province, postalCode }.

Strict rules:
- The document may be in Thai. Translate or transliterate every value to English.
- All text values must be UPPERCASE English, except postalCode which must be digits only.
- "houseNo" is the building/house number only.
- "road" is the street/road name (ถนน) without the word "ROAD".
- Do NOT extract or include soi (ซอย), moo (หมู่), alley, or lane information in any field.
- "subDistrict" is the tambon/khwaeng (ตำบล/แขวง).
- "district" is the amphoe/khet (อำเภอ/เขต).
- "province" is the changwat (จังหวัด).
- "postalCode" is the 5-digit Thai postal code (รหัสไปรษณีย์), digits only — e.g. "10110".
- If a field is unreadable or missing, return an empty string "" for it. Do NOT guess.
- Return only the JSON object — no prose, no markdown fences.`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const details: Record<string, unknown> = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
    const apiErr = err as Error & {
      status?: number;
      statusCode?: number;
      cause?: unknown;
      error?: unknown;
    };
    if (apiErr.status !== undefined) details.status = apiErr.status;
    if (apiErr.statusCode !== undefined) details.statusCode = apiErr.statusCode;
    if (apiErr.cause !== undefined) details.cause = apiErr.cause;
    if (apiErr.error !== undefined) details.error = apiErr.error;
    return details;
  }
  return { value: err };
}

function logScanEvent(phase: string, details?: Record<string, unknown>) {
  if (details) {
    console.log(`[scanTm30] ${phase}`, details);
  } else {
    console.log(`[scanTm30] ${phase}`);
  }
}

function logScanError(phase: string, err: unknown, details?: Record<string, unknown>) {
  console.error(`[scanTm30] ${phase}`, {
    ...details,
    error: formatError(err),
  });
}

function hasPdfMagicBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  );
}

function isPdfUpload(file: File, bytes: Uint8Array): boolean {
  if (file.type === PDF_MIME) return true;
  if (file.name.toLowerCase().endsWith(".pdf")) return true;
  return hasPdfMagicBytes(bytes);
}

async function waitForActiveFile(ai: GoogleGenAI, fileName: string) {
  const deadline = Date.now() + FILE_ACTIVE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const file = await ai.files.get({ name: fileName });
    logScanEvent("poll file state", {
      name: file.name,
      state: file.state,
      uri: file.uri,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      error: file.error,
    });

    if (file.state === "ACTIVE") return file;
    if (file.state === "FAILED") {
      throw new Error(
        `Gemini file processing failed: ${JSON.stringify(file.error ?? { state: file.state })}`,
      );
    }

    await sleep(FILE_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for Gemini file to become ACTIVE: ${fileName}`);
}

async function uploadPdfToGemini(ai: GoogleGenAI, file: File, bytes: ArrayBuffer) {
  const blob = new Blob([bytes], { type: PDF_MIME });

  logScanEvent("uploading PDF to Gemini Files API", {
    fileName: file.name,
    clientMimeType: file.type || "(empty)",
    sizeBytes: file.size,
  });

  const uploaded = await ai.files.upload({
    file: blob,
    config: {
      mimeType: PDF_MIME,
      displayName: file.name || "tm30.pdf",
    },
  });

  logScanEvent("upload complete", {
    name: uploaded.name,
    uri: uploaded.uri,
    state: uploaded.state,
    mimeType: uploaded.mimeType,
    sizeBytes: uploaded.sizeBytes,
  });

  if (!uploaded.name) {
    throw new Error("Gemini file upload returned no resource name.");
  }

  const readyFile =
    uploaded.state === "ACTIVE" ? uploaded : await waitForActiveFile(ai, uploaded.name);

  if (!readyFile.uri) {
    throw new Error("Gemini file is ACTIVE but has no URI.");
  }

  return readyFile;
}

async function deleteGeminiFile(ai: GoogleGenAI, fileName: string | undefined) {
  if (!fileName) return;
  try {
    await ai.files.delete({ name: fileName });
    logScanEvent("deleted uploaded file", { name: fileName });
  } catch (err) {
    logScanError("failed to delete uploaded file", err, { name: fileName });
  }
}

export async function scanTm30(formData: FormData): Promise<Tm30ScanResponse> {
  logScanEvent("request received");

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logScanError("missing API key", new Error("GEMINI_API_KEY is not set"));
    return {
      ok: false,
      error: "Server is missing GEMINI_API_KEY. Add it to .env.local and restart the dev server.",
    };
  }

  const file = formData.get("document");
  if (!(file instanceof File)) {
    logScanError("invalid upload", new Error("FormData field 'document' is missing or not a File"));
    return { ok: false, error: "No PDF was provided." };
  }

  logScanEvent("upload metadata", {
    fileName: file.name,
    mimeType: file.type || "(empty)",
    sizeBytes: file.size,
  });

  if (file.size > MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return { ok: false, error: `PDF is ${mb} MB; please upload under 10 MB.` };
  }

  const bytes = await file.arrayBuffer();
  const byteView = new Uint8Array(bytes);

  if (!isPdfUpload(file, byteView)) {
    logScanError("unsupported file type", new Error("Upload is not recognized as PDF"), {
      fileName: file.name,
      mimeType: file.type || "(empty)",
    });
    return { ok: false, error: "File must be a PDF document." };
  }
  if (!hasPdfMagicBytes(byteView)) {
    logScanError("invalid PDF header", new Error("Missing %PDF magic bytes"), {
      fileName: file.name,
      firstBytes: Array.from(byteView.slice(0, 8)),
    });
    return { ok: false, error: "The uploaded file does not appear to be a valid PDF." };
  }

  const ai = new GoogleGenAI({ apiKey });
  let uploadedFileName: string | undefined;

  try {
    const geminiFile = await uploadPdfToGemini(ai, file, bytes);
    uploadedFileName = geminiFile.name;

    const request = {
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              fileData: {
                fileUri: geminiFile.uri,
                mimeType: PDF_MIME,
              },
            },
            { text: PROMPT },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            houseNo: { type: Type.STRING },
            road: { type: Type.STRING },
            subDistrict: { type: Type.STRING },
            district: { type: Type.STRING },
            province: { type: Type.STRING },
            postalCode: { type: Type.STRING },
          },
          required: [
            "houseNo",
            "road",
            "subDistrict",
            "district",
            "province",
            "postalCode",
          ],
          propertyOrdering: [
            "houseNo",
            "road",
            "subDistrict",
            "district",
            "province",
            "postalCode",
          ],
        },
      },
    };

    logScanEvent("calling Gemini generateContent", {
      model: MODEL,
      fileUri: geminiFile.uri,
    });

    let text: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        logScanEvent("generateContent attempt", { attempt, maxAttempts: MAX_ATTEMPTS });
        const response = await ai.models.generateContent(request);
        text = response.text;
        logScanEvent("generateContent success", {
          attempt,
          responseLength: text?.length ?? 0,
          responsePreview: text?.slice(0, 200),
        });
        break;
      } catch (err) {
        logScanError("generateContent attempt failed", err, { attempt });
        if (isTransientGeminiError(err) && attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
    }

    if (!text) {
      return {
        ok: false,
        error: "The AI returned an empty response. Try a clearer TM.30 PDF.",
      };
    }

    let parsed: AiTm30ScanResult;
    try {
      parsed = JSON.parse(text) as AiTm30ScanResult;
      logScanEvent("parsed address JSON", parsed);
    } catch (parseErr) {
      logScanError("JSON parse failed", parseErr, { rawText: text });
      return {
        ok: false,
        error: "The AI returned an invalid response. Please try uploading the TM.30 PDF again.",
      };
    }

    return { ok: true, data: parsed };
  } catch (err) {
    logScanError("scan failed", err, {
      fileName: file.name,
      sizeBytes: file.size,
      model: MODEL,
      kind: classifyGeminiError(err),
    });

    return { ok: false, error: friendlyGeminiMessage(err, "TM.30 PDF") };
  } finally {
    await deleteGeminiFile(ai, uploadedFileName);
  }
}
