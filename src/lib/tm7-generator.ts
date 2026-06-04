// =============================================================
// TM.7 Master PDF Generator
// =============================================================
// Loads the 5-page master template (tm7-master.pdf) and overlays
// applicant data onto the form fields.
//
// Pages:
//   1-2: TM.7 form (personal details, address)
//   3:   STM.2
//   4:   STM.9 / Overstay
//   5:   STM.11
// =============================================================

import { PDFDocument, rgb } from "pdf-lib";
import fs from "fs";
import path from "path";

export type Title = "MR." | "MRS." | "MISS";

export type Tm7FormData = {
  // Personal
  title: Title;
  firstName: string;
  lastName: string;
  nationality: string;
  dateOfBirth?: string;          // ISO yyyy-mm-dd
  placeOfBirth?: string;

  // Passport
  passportNo: string;
  passportIssueDate?: string;    // ISO
  passportExpiryDate?: string;   // ISO
  passportIssuedAt?: string;

  // Arrival
  arrivalDate?: string;          // ISO
  fromCountry?: string;
  portOfArrival?: string;
  arrivedBy?: string;
  visaType?: string;

  // Address in Thailand
  houseNo?: string;
  road?: string;
  subDistrict?: string;
  district?: string;
  province?: string;
  postalCode?: string;
  phone?: string;

  // Extension
  appointmentDate?: string;      // ISO — used as form date
  formLocation?: string;         // e.g. BANGKOK
  extensionDays?: number;        // default 30
  extensionReason?: string;      // default TOURISM
};

let cachedTemplate: Uint8Array | null = null;
let cachedFont: Uint8Array | null = null;

async function loadTemplate(): Promise<Uint8Array> {
  if (cachedTemplate) return cachedTemplate;
  const p = path.join(process.cwd(), "public", "templates", "tm7-master.pdf");
  cachedTemplate = new Uint8Array(fs.readFileSync(p));
  return cachedTemplate;
}

async function loadFont(): Promise<Uint8Array> {
  if (cachedFont) return cachedFont;
  const p = path.join(process.cwd(), "public", "fonts", "Sarabun-Regular.ttf");
  cachedFont = new Uint8Array(fs.readFileSync(p));
  return cachedFont;
}

const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

function parseDate(s: string | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function splitDate(d: Date | null): { day: string; month: string; year: string } {
  if (!d) return { day: "", month: "", year: "" };
  return {
    day: d.getDate().toString(),
    month: MONTHS[d.getMonth()],
    year: d.getFullYear().toString(),
  };
}

function calcAge(dob: Date | null): string {
  if (!dob) return "";
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age.toString();
}

export async function generateTm7Pdf(data: Tm7FormData): Promise<Uint8Array> {
  const templateBytes = await loadTemplate();
  const pdfDoc = await PDFDocument.load(templateBytes);

  const fontkit = (await import("@pdf-lib/fontkit")).default;
  pdfDoc.registerFontkit(fontkit);

  const fontBytes = await loadFont();
  const font = await pdfDoc.embedFont(fontBytes);

  const pages = pdfDoc.getPages();
  const [page1, page2, page3, page4, page5] = pages;

  const S = 11;
  const C = rgb(0.1, 0.2, 0.8); // ballpoint blue

  // ── Merge data ───────────────────────────────────────────────
  const firstName = data.firstName.toUpperCase();
  const lastName = data.lastName.toUpperCase();
  const nationality = data.nationality.toUpperCase();
  const passportNo = data.passportNo.toUpperCase();
  const applicantTitle = data.title;
  const fullName = `${lastName}       ${firstName}`;
  const titledName = `${applicantTitle} ${lastName} ${firstName}`.replace(/\s+/g, " ").trim();

  const formLocation = (data.formLocation || "BANGKOK").toUpperCase();
  const extensionDays = (data.extensionDays ?? 30).toString();
  const extensionReason = (data.extensionReason || "TOURISM").toUpperCase();
  const portOfArrival = (data.portOfArrival || "").toUpperCase();
  const arrivedBy = (data.arrivedBy || "").toUpperCase();
  const fromCountry = (data.fromCountry || "").toUpperCase();
  const placeOfBirth = (data.placeOfBirth || "").toUpperCase();
  const passportIssuedAt = (data.passportIssuedAt || "").toUpperCase();
  const visaType = (data.visaType || "").toUpperCase();

  const dob = parseDate(data.dateOfBirth);
  const calculatedAge = calcAge(dob);
  const dobParts = splitDate(dob);

  const formDateSource = parseDate(data.appointmentDate) || new Date();
  const formDate = splitDate(formDateSource);
  const printDate = formDateSource
    .toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
    .toUpperCase();

  const issueDateObj = parseDate(data.passportIssueDate);
  const expiryDateObj = parseDate(data.passportExpiryDate);
  const arrivalDateObj = parseDate(data.arrivalDate);

  const fmtDay = (d: Date | null) =>
    d ? d.toLocaleDateString("en-GB", { day: "2-digit" }) : "";
  const fmtMonthShort = (d: Date | null) =>
    d ? d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase().trim() : "";
  const fmtMonthLong = (d: Date | null) =>
    d ? d.toLocaleDateString("en-GB", { month: "long" }).toUpperCase().trim() : "";
  const fmtYear = (d: Date | null) =>
    d ? d.toLocaleDateString("en-GB", { year: "numeric" }) : "";

  const issueDay = issueDateObj ? issueDateObj.getDate().toString() : "";
  const issMonth = fmtMonthShort(issueDateObj);
  const issYear = fmtYear(issueDateObj);
  const expDay = fmtDay(expiryDateObj);
  const expMonth = fmtMonthShort(expiryDateObj);
  const expYear = fmtYear(expiryDateObj);
  const arrDay = fmtDay(arrivalDateObj);
  const arrMonth = fmtMonthLong(arrivalDateObj);
  const arrYear = fmtYear(arrivalDateObj);

  const houseNo = (data.houseNo || "").trim();
  const road = (data.road || "").trim();
  const subDistrict = (data.subDistrict || "").trim();
  const district = (data.district || "").trim();
  const province = (data.province || "").trim();
  const postalCode = (data.postalCode || "").trim();
  const phone = (data.phone || "").trim();
  const provinceZip = postalCode ? `${province} ${postalCode}` : province;
  const fullAddress = `${houseNo} ${road}, ${subDistrict}, ${district}, ${provinceZip}`;
  const lineThickness = 1.5;

  // ── Page 1: TM.7 personal details ──────────────────────────
  page1.drawText(formLocation, { x: 450, y: 708, size: 12, font, color: C });

  page1.drawText(formDate.day, { x: 350, y: 660, size: 12, font, color: C });
  page1.drawText(formDate.month, { x: 405, y: 660, size: 12, font, color: C });
  page1.drawText(formDate.year, { x: 510, y: 660, size: 12, font, color: C });

  const surnameY = 578;
  const titleEngY = surnameY - 15;
  if (applicantTitle === "MR.") {
    page1.drawLine({
      start: { x: 160, y: titleEngY - 6 },
      end: { x: 185, y: titleEngY - 6 },
      thickness: lineThickness, color: C,
    });
  } else {
    page1.drawLine({
      start: { x: 137.5, y: titleEngY - 6 },
      end: { x: 152.5, y: titleEngY - 6 },
      thickness: lineThickness, color: C,
    });
  }

  page1.drawText(lastName, { x: 285, y: 578, size: 12, font, color: C });
  page1.drawText(firstName, { x: 435, y: 578, size: 12, font, color: C });
  page1.drawText("-", { x: 175, y: 541, size: 12, font, color: C });
  page1.drawText(placeOfBirth, { x: 175, y: 505, size: 12, font, color: C });
  page1.drawText(nationality, { x: 460, y: 505, size: 12, font, color: C });

  if (dob) {
    page1.drawText(dobParts.day, { x: 375, y: 541, size: 12, font, color: C });
    page1.drawText(dobParts.month, { x: 445, y: 541, size: 12, font, color: C });
    page1.drawText(dobParts.year, { x: 525, y: 541, size: 12, font, color: C });
  }
  page1.drawText(calculatedAge, { x: 285, y: 541, size: 12, font, color: C });

  page1.drawText(portOfArrival, { x: 150, y: 332, size: 12, font, color: C });
  page1.drawText(arrivedBy, { x: 185, y: 368, size: 12, font, color: C });

  page1.drawText(issueDay, { x: 480, y: 436, size: 12, font, color: C });
  page1.drawText(issMonth, { x: 105, y: 436, size: 12, font, color: C });
  page1.drawText(issYear, { x: 205, y: 436, size: 12, font, color: C });
  page1.drawText(passportIssuedAt, { x: 300, y: 436, size: 12, font, color: C });
  page1.drawText(expDay, { x: 480, y: 478, size: 12, font, color: C });
  page1.drawText(expMonth, { x: 105, y: 406, size: 12, font, color: C });
  page1.drawText(expYear, { x: 205, y: 406, size: 12, font, color: C });
  page1.drawText(visaType, { x: 350, y: 406, size: 12, font, color: C });
  page1.drawText(fromCountry, { x: 350, y: 368, size: 12, font, color: C });
  page1.drawText(arrDay, { x: 350, y: 332, size: 12, font, color: C });
  page1.drawText(arrMonth, { x: 415, y: 332, size: 12, font, color: C });
  page1.drawText(arrYear, { x: 510, y: 332, size: 12, font, color: C });

  page1.drawText(passportNo, { x: 330, y: 478, size: 12, font, color: C });
  page1.drawText(extensionDays, { x: 475, y: 268, size: 12, font, color: C });
  page1.drawText(extensionReason, { x: 275, y: 196, size: 12, font, color: C });

  // ── Page 2: TM.7 continuation + address ───────────────────
  page2.drawText(titledName, { x: 250, y: 722, size: S, font, color: C });

  const addressLine1Y = 680;
  const addressLine2Y = 640;
  const fullAddressY = addressLine2Y + 115;

  page2.drawText(houseNo, { x: 150, y: addressLine1Y, size: 12, font, color: C });
  page2.drawText(road, { x: 245, y: addressLine1Y, size: 12, font, color: C });
  page2.drawText(subDistrict, { x: 440, y: addressLine1Y, size: 12, font, color: C });
  page2.drawText(district, { x: 150, y: addressLine2Y, size: 12, font, color: C });
  page2.drawText(provinceZip, { x: 365, y: addressLine2Y, size: 12, font, color: C });
  if (phone) {
    page2.drawText(phone, { x: 150, y: addressLine2Y - 40, size: 12, font, color: C });
  }
  page2.drawText(fullAddress, { x: 175, y: fullAddressY, size: 8, font, color: C });

  // ── Page 3: STM.2 ──────────────────────────────────────────
  page3.drawText(fullName, { x: 200, y: 374, size: S, font, color: C });
  page3.drawText(printDate, { x: 425, y: 410, size: S, font, color: C });
  page3.drawText(nationality, { x: 425, y: 375, size: 12, font, color: C });
  page3.drawText(calculatedAge, { x: 310, y: 375, size: 12, font, color: C });
  page3.drawText(extensionReason, { x: 425, y: 352.5, size: 12, font, color: C });

  const p3LineY = 372.5;
  if (applicantTitle === "MR.") {
    page3.drawLine({ start: { x: 115, y: p3LineY }, end: { x: 158, y: p3LineY }, thickness: lineThickness, color: C });
  } else {
    page3.drawLine({ start: { x: 100, y: p3LineY }, end: { x: 130, y: p3LineY }, thickness: lineThickness, color: C });
  }

  // ── Page 4: STM.9 / Overstay ──────────────────────────────
  page4.drawText(lastName, { x: 280, y: 584, size: S, font, color: C });
  page4.drawText(firstName, { x: 430, y: 584, size: S, font, color: C });
  page4.drawText(formDate.day, { x: 405, y: 624, size: 12, font, color: C });
  page4.drawText(formDate.month, { x: 445, y: 624, size: 12, font, color: C });
  page4.drawText(formDate.year, { x: 530, y: 624, size: 12, font, color: C });
  page4.drawText(formLocation, { x: 450, y: 664, size: 12, font, color: C });
  page4.drawText("-", { x: 300, y: 650, size: 12, font, color: C });
  page4.drawText(calculatedAge, { x: 215, y: 550, size: 12, font, color: C });
  page4.drawText(nationality, { x: 300, y: 550, size: 12, font, color: C });
  page4.drawText(passportNo, { x: 465, y: 550, size: 12, font, color: C });

  const p4LineY = 564;
  if (applicantTitle === "MR.") {
    page4.drawLine({ start: { x: 150, y: p4LineY }, end: { x: 185, y: p4LineY }, thickness: lineThickness, color: C });
  } else {
    page4.drawLine({ start: { x: 130, y: p4LineY }, end: { x: 159, y: p4LineY }, thickness: lineThickness, color: C });
  }

  // ── Page 5: STM.11 ────────────────────────────────────────
  page5.drawText(fullName, { x: 250, y: 374, size: S, font, color: C });
  page5.drawText(printDate, { x: 450, y: 410, size: S, font, color: C });

  const p5LineY = 371.5;
  if (applicantTitle === "MR.") {
    page5.drawLine({ start: { x: 150, y: p5LineY }, end: { x: 200, y: p5LineY }, thickness: lineThickness, color: C });
  } else {
    page5.drawLine({ start: { x: 140, y: p5LineY }, end: { x: 170, y: p5LineY }, thickness: lineThickness, color: C });
  }

  page5.drawText(calculatedAge, { x: 465, y: 374, size: 12, font, color: C });
  page5.drawText(nationality, { x: 125, y: 354, size: 12, font, color: C });
  page5.drawText(passportNo, { x: 300, y: 354, size: 12, font, color: C });

  const p5Address = [houseNo, road, subDistrict, district, provinceZip]
    .filter(Boolean)
    .join(", ");
  const p5AddressFull = phone ? `${p5Address}, Tel: ${phone}` : p5Address;
  page5.drawText(p5AddressFull, { x: 210, y: 233, size: 10, font, color: C });

  page5.drawText("X", { x: 135, y: 276.5, size: 12, font, color: C });
  page5.drawText(extensionReason, { x: 165, y: 251.5, size: 12, font, color: C });
  page5.drawText(titledName, { x: 165, y: 216.5, size: 12, font, color: C });

  return await pdfDoc.save();
}
