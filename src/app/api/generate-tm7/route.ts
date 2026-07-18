import { NextRequest, NextResponse } from "next/server";
import { generateTm7Pdf, type Tm7FormData } from "@/lib/tm7-generator";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const payloadRaw = formData.get("payload");
    if (typeof payloadRaw !== "string") {
      return NextResponse.json(
        { error: "Missing form payload." },
        { status: 400 }
      );
    }
    const data = JSON.parse(payloadRaw) as Tm7FormData;

    if (!data?.firstName || !data?.lastName || !data?.passportNo || !data?.nationality || !data?.title) {
      return NextResponse.json(
        { error: "Missing required fields: title, firstName, lastName, nationality, passportNo." },
        { status: 400 }
      );
    }

    const tm30 = formData.get("tm30");
    let tm30Bytes: Uint8Array | undefined;
    if (tm30 instanceof File && tm30.size > 0) {
      tm30Bytes = new Uint8Array(await tm30.arrayBuffer());
    }

    const pdfBytes = await generateTm7Pdf(data, tm30Bytes);
    const safePassport = data.passportNo.replace(/[^A-Za-z0-9_-]/g, "");
    const filename = `TM7-${safePassport || "form"}.pdf`;

    return new NextResponse(Buffer.from(pdfBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "PDF generation failed";
    if (msg.includes("WinAnsi") || msg.includes("cannot encode")) {
      return NextResponse.json(
        { error: "Please ensure all fields contain only English characters." },
        { status: 400 }
      );
    }
    console.error("[TM7 API] Generation failed:", err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
