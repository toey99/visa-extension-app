"use server";

import { GoogleGenAI, Type } from "@google/genai";
import { friendlyGeminiMessage, isTransientGeminiError } from "@/lib/geminiError";

export type AiScanResult = {
  title: "MR." | "MRS." | "MISS";
  firstName: string;
  lastName: string;
  nationality: string;          // demonym, e.g. CHINESE
  dateOfBirth: string;          // DD/MM/YYYY
  placeOfBirth: string;
  passportNo: string;
  passportIssueDate: string;    // DD/MM/YYYY
  passportExpiryDate: string;   // DD/MM/YYYY
  passportIssuedAt: string;
};

export type ScanResponse =
  | { ok: true; data: AiScanResult }
  | { ok: false; error: string };

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROMPT = `You are reading the bio-data page of an international passport.
Extract the applicant's details and return them as JSON matching the provided schema.

Strict rules:
- All text values must be UPPERCASE English.
- "nationality" must be the English DEMONYM (e.g. CHINESE, BRITISH, AMERICAN, THAI). Never an ISO code or country name.
- "title": "MR." for male, "MRS." for married female, "MISS" for unmarried female. If sex is M, return "MR."; if F and you can't tell married vs. unmarried, return "MRS.".
- All dates must be formatted as DD/MM/YYYY (two-digit day, two-digit month, four-digit year).
- "passportNo" is the document number printed on the bio page (often top-right), not the personal number from the MRZ.
- If a field is unreadable or missing from the image, return an empty string "" for it. Do NOT guess.
- Return only the JSON object — no prose, no markdown fences.`;

export async function scanPassport(formData: FormData): Promise<ScanResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "Server is missing GEMINI_API_KEY. Add it to .env.local and restart the dev server.",
    };
  }

  const file = formData.get("image");
  if (!(file instanceof File)) {
    return { ok: false, error: "No image was provided." };
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { ok: false, error: "File must be a JPEG, PNG, or WebP image." };
  }
  if (file.size > MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return { ok: false, error: `Image is ${mb} MB; please upload under 8 MB.` };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");

    const request = {
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: file.type, data: base64 } },
            { text: PROMPT },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING, enum: ["MR.", "MRS.", "MISS"] },
            firstName: { type: Type.STRING },
            lastName: { type: Type.STRING },
            nationality: { type: Type.STRING },
            dateOfBirth: { type: Type.STRING },
            placeOfBirth: { type: Type.STRING },
            passportNo: { type: Type.STRING },
            passportIssueDate: { type: Type.STRING },
            passportExpiryDate: { type: Type.STRING },
            passportIssuedAt: { type: Type.STRING },
          },
          required: [
            "title",
            "firstName",
            "lastName",
            "nationality",
            "dateOfBirth",
            "placeOfBirth",
            "passportNo",
            "passportIssueDate",
            "passportExpiryDate",
            "passportIssuedAt",
          ],
          propertyOrdering: [
            "title",
            "firstName",
            "lastName",
            "nationality",
            "dateOfBirth",
            "placeOfBirth",
            "passportNo",
            "passportIssueDate",
            "passportExpiryDate",
            "passportIssuedAt",
          ],
        },
      },
    };

    // Retry transient errors (503 overload, 429 rate-limit, 500 server)
    // with a short delay between tries; fail fast on permanent ones.
    let text: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await ai.models.generateContent(request);
        text = response.text;
        break;
      } catch (err) {
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
        error: "The AI returned an empty response. Try a clearer photo of the bio page.",
      };
    }

    const parsed = JSON.parse(text) as AiScanResult;
    return { ok: true, data: parsed };
  } catch (err) {
    // Log the raw error server-side, surface a clean, classified message.
    console.error("Gemini passport scan failed:", err);
    return { ok: false, error: friendlyGeminiMessage(err, "passport") };
  }
}
