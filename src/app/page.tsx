"use client";

import { useState, useRef, useEffect } from "react";
import type { Tm7FormData, Title } from "@/lib/tm7-generator";

type FormState = {
  title: Title;
  firstName: string;
  lastName: string;
  nationality: string;
  dateOfBirth: string;
  placeOfBirth: string;
  passportNo: string;
  passportIssueDate: string;
  passportExpiryDate: string;
  passportIssuedAt: string;
  arrivalDate: string;
  fromCountry: string;
  portOfArrival: string;
  arrivedBy: string;
  visaType: string;
  houseNo: string;
  road: string;
  subDistrict: string;
  district: string;
  province: string;
  postalCode: string;
  phone: string;
  appointmentDate: string;
  formLocation: string;
  extensionDays: string;
  extensionReason: string;
};

const INITIAL: FormState = {
  title: "MR.",
  firstName: "",
  lastName: "",
  nationality: "",
  dateOfBirth: "",
  placeOfBirth: "",
  passportNo: "",
  passportIssueDate: "",
  passportExpiryDate: "",
  passportIssuedAt: "",
  arrivalDate: "",
  fromCountry: "",
  portOfArrival: "SUVARNABHUMI",
  arrivedBy: "AIRPLANE",
  visaType: "EXEMPTION (PORPOR 60)",
  houseNo: "",
  road: "",
  subDistrict: "",
  district: "",
  province: "",
  postalCode: "",
  phone: "",
  appointmentDate: "",
  formLocation: "BANGKOK",
  extensionDays: "30",
  extensionReason: "TOURISM",
};

export default function Page() {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>("");
  const [pdfUrl, setPdfUrl] = useState<string>("");
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    if (pdfUrl) {
      URL.revokeObjectURL(pdfUrl);
      setPdfUrl("");
    }

    const payload: Tm7FormData = {
      title: form.title,
      firstName: form.firstName,
      lastName: form.lastName,
      nationality: form.nationality,
      dateOfBirth: form.dateOfBirth || undefined,
      placeOfBirth: form.placeOfBirth || undefined,
      passportNo: form.passportNo,
      passportIssueDate: form.passportIssueDate || undefined,
      passportExpiryDate: form.passportExpiryDate || undefined,
      passportIssuedAt: form.passportIssuedAt || undefined,
      arrivalDate: form.arrivalDate || undefined,
      fromCountry: form.fromCountry || undefined,
      portOfArrival: form.portOfArrival || undefined,
      arrivedBy: form.arrivedBy || undefined,
      visaType: form.visaType || undefined,
      houseNo: form.houseNo || undefined,
      road: form.road || undefined,
      subDistrict: form.subDistrict || undefined,
      district: form.district || undefined,
      province: form.province || undefined,
      postalCode: form.postalCode || undefined,
      phone: form.phone || undefined,
      appointmentDate: form.appointmentDate || undefined,
      formLocation: form.formLocation || undefined,
      extensionDays: form.extensionDays ? Number(form.extensionDays) : undefined,
      extensionReason: form.extensionReason || undefined,
    };

    try {
      const res = await fetch("/api/generate-tm7", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPdfUrl(url);

      setTimeout(() => {
        previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate PDF");
    } finally {
      setSubmitting(false);
    }
  }

  function handleDownload() {
    if (!pdfUrl) return;
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.download = `TM7-${form.passportNo || "form"}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function handlePrint() {
    if (!pdfUrl) return;
    const w = window.open(pdfUrl, "_blank");
    if (w) {
      w.addEventListener("load", () => w.print(), { once: true });
    }
  }

  function handleReset() {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl("");
    setForm(INITIAL);
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          TM.7 Visa Extension Form
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          Fill in your details below and generate a printable TM.7 packet (5 pages: TM.7, STM.2, STM.9, STM.11).
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Section title="Personal Information" subtitle="As shown in your passport">
          <Field label="Title" required>
            <select
              value={form.title}
              onChange={(e) => set("title", e.target.value as Title)}
              className={inputCls}
            >
              <option value="MR.">Mr.</option>
              <option value="MRS.">Mrs.</option>
              <option value="MISS">Miss</option>
            </select>
          </Field>
          <Field label="First Name" required>
            <input
              type="text"
              required
              value={form.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              placeholder="JOHN"
              className={inputCls}
            />
          </Field>
          <Field label="Last Name" required>
            <input
              type="text"
              required
              value={form.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              placeholder="DOE"
              className={inputCls}
            />
          </Field>
          <Field label="Nationality" required>
            <input
              type="text"
              required
              value={form.nationality}
              onChange={(e) => set("nationality", e.target.value)}
              placeholder="BRITISH"
              className={inputCls}
            />
          </Field>
          <Field label="Date of Birth">
            <input
              type="date"
              value={form.dateOfBirth}
              onChange={(e) => set("dateOfBirth", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Place of Birth">
            <input
              type="text"
              value={form.placeOfBirth}
              onChange={(e) => set("placeOfBirth", e.target.value)}
              placeholder="LONDON"
              className={inputCls}
            />
          </Field>
        </Section>

        <Section title="Passport" subtitle="From the bio page">
          <Field label="Passport Number" required>
            <input
              type="text"
              required
              value={form.passportNo}
              onChange={(e) => set("passportNo", e.target.value.toUpperCase())}
              placeholder="AB1234567"
              className={inputCls}
            />
          </Field>
          <Field label="Issued At (country)">
            <input
              type="text"
              value={form.passportIssuedAt}
              onChange={(e) => set("passportIssuedAt", e.target.value)}
              placeholder="UNITED KINGDOM"
              className={inputCls}
            />
          </Field>
          <Field label="Date of Issue">
            <input
              type="date"
              value={form.passportIssueDate}
              onChange={(e) => set("passportIssueDate", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Date of Expiry">
            <input
              type="date"
              value={form.passportExpiryDate}
              onChange={(e) => set("passportExpiryDate", e.target.value)}
              className={inputCls}
            />
          </Field>
        </Section>

        <Section title="Arrival in Thailand" subtitle="From the latest entry stamp / TM.6">
          <Field label="Arrival Date">
            <input
              type="date"
              value={form.arrivalDate}
              onChange={(e) => set("arrivalDate", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="From (Country)">
            <input
              type="text"
              value={form.fromCountry}
              onChange={(e) => set("fromCountry", e.target.value)}
              placeholder="UNITED KINGDOM"
              className={inputCls}
            />
          </Field>
          <Field label="Port of Arrival">
            <input
              type="text"
              value={form.portOfArrival}
              onChange={(e) => set("portOfArrival", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Arrived By">
            <input
              type="text"
              value={form.arrivedBy}
              onChange={(e) => set("arrivedBy", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Type of Visa" full>
            <input
              type="text"
              value={form.visaType}
              onChange={(e) => set("visaType", e.target.value)}
              className={inputCls}
            />
          </Field>
        </Section>

        <Section title="Address in Thailand" subtitle="Where you are currently staying">
          <Field label="House No.">
            <input
              type="text"
              value={form.houseNo}
              onChange={(e) => set("houseNo", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Road / Street">
            <input
              type="text"
              value={form.road}
              onChange={(e) => set("road", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Sub-District (Tambol)">
            <input
              type="text"
              value={form.subDistrict}
              onChange={(e) => set("subDistrict", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="District (Amphur)">
            <input
              type="text"
              value={form.district}
              onChange={(e) => set("district", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Province">
            <input
              type="text"
              value={form.province}
              onChange={(e) => set("province", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Postal Code">
            <input
              type="text"
              value={form.postalCode}
              onChange={(e) => set("postalCode", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Phone" full>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="+66 8x xxx xxxx"
              className={inputCls}
            />
          </Field>
        </Section>

        <Section title="Extension Request" subtitle="Details for the application">
          <Field label="Form Date (Appointment)">
            <input
              type="date"
              value={form.appointmentDate}
              onChange={(e) => set("appointmentDate", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Form Location">
            <input
              type="text"
              value={form.formLocation}
              onChange={(e) => set("formLocation", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Extension Days">
            <input
              type="number"
              min={1}
              max={365}
              value={form.extensionDays}
              onChange={(e) => set("extensionDays", e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Reason for Extension">
            <input
              type="text"
              value={form.extensionReason}
              onChange={(e) => set("extensionReason", e.target.value)}
              className={inputCls}
            />
          </Field>
        </Section>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={handleReset}
            className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            Reset
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {submitting && (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
            )}
            {submitting ? "Generating..." : "Generate TM.7 PDF"}
          </button>
        </div>
      </form>

      {pdfUrl && (
        <div ref={previewRef} className="mt-12 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Preview</h2>
              <p className="text-sm text-slate-500">5 pages: TM.7, STM.2, STM.9, STM.11</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handlePrint}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Print
              </button>
              <button
                onClick={handleDownload}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
              >
                Download PDF
              </button>
            </div>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <iframe
              src={pdfUrl}
              className="h-[80vh] w-full"
              title="Generated TM.7 PDF"
            />
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm transition-colors focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none";

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
      <div className="mb-5">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  full,
  children,
}: {
  label: string;
  required?: boolean;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <label className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
