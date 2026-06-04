import { NextRequest, NextResponse } from "next/server";
import { generateTm7Pdf, type Tm7FormData } from "@/lib/tm7-generator";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const data = (await req.json()) as Tm7FormData;

    if (!data?.firstName || !data?.lastName || !data?.passportNo || !data?.nationality || !data?.title) {
      return NextResponse.json(
        { error: "Missing required fields: title, firstName, lastName, nationality, passportNo." },
        { status: 400 }
      );
    }

    const pdfBytes = await generateTm7Pdf(data);
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
