"use client";

// =============================================================
// /today — งานวันนี้ (daily board)
// =============================================================
// Drop every image the agents sent for the day; each is classified and
// read by Gemini, grouped into people (a passport starts a new person,
// the stamp / selfie / TM.30 that follow belong to that person), and the
// day can then be turned into TM.7 packets, the TM.30 upload Excel and a
// folder tree zip — all from one screen. State lives in IndexedDB.

import { useCallback, useEffect, useRef, useState } from "react";
import { analyzeDoc, type AnalyzedDoc } from "@/app/actions/analyzeDoc";
import { scanTm30 } from "@/app/actions/scanTm30";
import { compressPdf } from "@/lib/compressPdf";
import type { Tm7FormData } from "@/lib/tm7-generator";
import {
  DEFAULT_META, EMPTY_FIELDS, OVERSTAY_FINE_PER_DAY, daysBetween, ddmmyyyyToIso, newId, parseDdmmyyyy,
  personFolderName, todayDdmmyyyy,
  type DayMeta, type DocFile, type DocType, type Person, type PersonFields,
} from "@/lib/today/types";
import { clearAll, deletePerson, loadAll, saveMeta, savePerson } from "@/lib/today/store";
import {
  buildDayZip, buildTm30Excel, downloadBlob, downscaleImage, mergePdfs, plusDaysDdmmyyyy,
} from "@/lib/today/clientTools";

const MAX_PDF_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 3;

export default function TodayPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [meta, setMeta] = useState<DayMeta>({ ...DEFAULT_META });
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const peopleRef = useRef<Person[]>([]);
  useEffect(() => { peopleRef.current = people; }, [people]);

  // ---------- load / persist ----------
  useEffect(() => {
    loadAll().then(({ people: p, meta: m }) => {
      setPeople(p);
      setMeta({ ...DEFAULT_META, ...(m ?? {}), date: m?.date || todayDdmmyyyy() });
      setLoaded(true);
    });
  }, []);

  function updateMeta(patch: Partial<DayMeta>) {
    setMeta((prev) => {
      const next = { ...prev, ...patch };
      saveMeta(next);
      return next;
    });
  }

  const upsertPerson = useCallback((p: Person) => {
    setPeople((prev) => {
      const i = prev.findIndex((x) => x.id === p.id);
      const next = i >= 0 ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p];
      next.sort((a, b) => a.order - b.order);
      return next;
    });
    savePerson(p);
  }, []);

  function patchPerson(id: string, fn: (p: Person) => Person) {
    const cur = peopleRef.current.find((x) => x.id === id);
    if (!cur) return;
    upsertPerson(fn(cur));
  }

  function removePerson(id: string) {
    setPeople((prev) => prev.filter((x) => x.id !== id));
    deletePerson(id);
  }

  function nextOrder(): number {
    return peopleRef.current.reduce((m, p) => Math.max(m, p.order), 0) + 1;
  }

  function addEmptyPerson(): Person {
    const p: Person = { id: newId(), order: nextOrder(), fields: { ...EMPTY_FIELDS }, files: [], createdAt: Date.now() };
    upsertPerson(p);
    return p;
  }

  // ---------- intake ----------
  async function handleFiles(fileList: FileList | File[]) {
    const files = [...fileList]
      .filter((f) => f.type.startsWith("image/") || /\.pdf$/i.test(f.name) || f.type === "application/pdf")
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) return;
    setError("");
    setWorking(true);

    // 1) downscale + register every file first (so the user sees them immediately)
    type Pending = { doc: DocFile; file: File; result?: AnalyzedDoc; address?: Partial<PersonFields> };
    const pending: Pending[] = [];
    for (const f of files) {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      let blob: Blob = f;
      if (isPdf) {
        if (f.size > MAX_PDF_BYTES) {
          try { blob = await compressPdf(f); } catch { blob = f; }
        }
      } else {
        blob = await downscaleImage(f);
      }
      pending.push({
        doc: { id: newId(), kind: isPdf ? "tm30" : "other", name: f.name, mime: isPdf ? "application/pdf" : "image/jpeg", blob, status: "queued" },
        file: f,
      });
    }

    // 2) analyze with limited concurrency
    let done = 0;
    const queue = [...pending];
    async function worker() {
      while (queue.length) {
        const item = queue.shift()!;
        item.doc.status = "analyzing";
        try {
          if (item.doc.mime === "application/pdf") {
            if (item.doc.blob.size > MAX_PDF_BYTES) throw new Error("PDF ใหญ่เกิน 4 MB หลังบีบอัด");
            const fd = new FormData();
            fd.append("document", new File([item.doc.blob], item.file.name, { type: "application/pdf" }));
            const r = await scanTm30(fd);
            if (!r.ok) throw new Error(r.error);
            item.address = r.data;
            item.doc.kind = "tm30";
          } else {
            const fd = new FormData();
            fd.append("image", new File([item.doc.blob], item.file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }));
            const r = await analyzeDoc(fd);
            if (!r.ok) throw new Error(r.error);
            item.result = r.data;
            item.doc.kind = r.data.docType;
            if (r.data.docType === "tm30") item.address = pickAddress(r.data);
          }
          item.doc.status = "done";
        } catch (e) {
          item.doc.status = "error";
          item.doc.error = e instanceof Error ? e.message : String(e);
        }
        done++;
        setStatus(`กำลังอ่านรูป ${done}/${pending.length}`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));

    // 3) group into people, in filename order: passport = new person; the
    //    files after it belong to that person until the next passport.
    let current: Person | null = null;
    const touched = new Map<string, Person>();
    const existing = () => [...peopleRef.current.filter((p) => !touched.has(p.id)), ...touched.values()];

    for (const item of pending) {
      const d = item.result;
      if (item.doc.kind === "passport" && d) {
        const byNo = d.passportNo ? existing().find((p) => p.fields.passportNo && p.fields.passportNo === d.passportNo) : undefined;
        const base: Person = byNo ?? { id: newId(), order: nextOrder() + touched.size, fields: { ...EMPTY_FIELDS }, files: [], createdAt: Date.now() };
        current = applyPassport(base, d);
        current = { ...current, files: [...current.files, item.doc] };
        touched.set(current.id, current);
        continue;
      }
      // TM.30 PDFs are usually named after the person — match by name tokens first
      let target: Person | null = null;
      if (item.doc.kind === "tm30") {
        const tokens = item.file.name.toUpperCase().replace(/\.[^.]+$/, "").split(/[^A-Z]+/).filter((t) => t.length > 1 && t !== "TM");
        target = existing().find((p) => {
          const nm = `${p.fields.firstName} ${p.fields.lastName}`.toUpperCase();
          return tokens.length > 0 && tokens.every((t) => nm.includes(t));
        }) ?? null;
      }
      if (!target) target = current ?? existing().slice(-1)[0] ?? null;
      if (!target) {
        target = { id: newId(), order: nextOrder() + touched.size, fields: { ...EMPTY_FIELDS }, files: [], createdAt: Date.now() };
      }
      let next: Person = { ...target, files: [...target.files, item.doc] };
      if (item.doc.kind === "stamp" && d) next = applyStamp(next, d);
      if (item.address) next = applyAddress(next, item.address);
      touched.set(next.id, next);
      if (current && current.id === next.id) current = next;
    }

    for (const p of touched.values()) upsertPerson(p);
    const errs = pending.filter((x) => x.doc.status === "error").length;
    setStatus(errs ? `อ่านเสร็จ มี ${errs} ไฟล์อ่านไม่ได้ (ดูป้ายแดงในการ์ด)` : `อ่านเสร็จ ${pending.length} ไฟล์`);
    setWorking(false);
  }

  function applyPassport(p: Person, d: AnalyzedDoc): Person {
    const f = p.fields;
    return {
      ...p,
      fields: {
        ...f,
        title: (d.title || f.title) as PersonFields["title"],
        firstName: d.firstName || f.firstName,
        lastName: d.lastName || f.lastName,
        chineseName: d.chineseName || f.chineseName,
        nationality: d.nationality || f.nationality,
        dateOfBirth: d.dateOfBirth || f.dateOfBirth,
        placeOfBirth: d.placeOfBirth || f.placeOfBirth,
        passportNo: d.passportNo || f.passportNo,
        passportIssueDate: d.passportIssueDate || f.passportIssueDate,
        passportExpiryDate: d.passportExpiryDate || f.passportExpiryDate,
        passportIssuedAt: d.passportIssuedAt || f.passportIssuedAt,
      },
    };
  }
  function applyStamp(p: Person, d: AnalyzedDoc): Person {
    const f = p.fields;
    return {
      ...p,
      fields: {
        ...f,
        arrivalDate: d.arrivalDate || f.arrivalDate,
        admittedUntil: d.admittedUntil || f.admittedUntil,
        portOfArrival: d.portOfArrival || f.portOfArrival,
        arrivedBy: d.arrivedBy || f.arrivedBy,
      },
    };
  }
  function pickAddress(a: AnalyzedDoc): Partial<PersonFields> {
    return { houseNo: a.houseNo, road: a.road, subDistrict: a.subDistrict, district: a.district, province: a.province, postalCode: a.postalCode };
  }
  function applyAddress(p: Person, a: Partial<PersonFields>): Person {
    const f = p.fields;
    return {
      ...p,
      fields: {
        ...f,
        houseNo: a.houseNo || f.houseNo,
        road: a.road || f.road,
        subDistrict: a.subDistrict || f.subDistrict,
        district: a.district || f.district,
        province: a.province || f.province,
        postalCode: a.postalCode || f.postalCode,
      },
    };
  }

  // ---------- TM.7 ----------
  async function generateTm7(p: Person): Promise<Blob> {
    const f = p.fields;
    const payload: Tm7FormData = {
      title: f.title,
      firstName: f.firstName,
      lastName: f.lastName,
      nationality: f.nationality,
      dateOfBirth: ddmmyyyyToIso(f.dateOfBirth),
      placeOfBirth: f.placeOfBirth || undefined,
      passportNo: f.passportNo,
      passportIssueDate: ddmmyyyyToIso(f.passportIssueDate),
      passportExpiryDate: ddmmyyyyToIso(f.passportExpiryDate),
      passportIssuedAt: f.passportIssuedAt || undefined,
      arrivalDate: ddmmyyyyToIso(f.arrivalDate),
      fromCountry: f.fromCountry || undefined,
      portOfArrival: f.portOfArrival || undefined,
      arrivedBy: f.arrivedBy || undefined,
      visaType: f.visaType || undefined,
      houseNo: f.houseNo || undefined,
      road: f.road || undefined,
      subDistrict: f.subDistrict || undefined,
      district: f.district || undefined,
      province: f.province || undefined,
      postalCode: f.postalCode || undefined,
      phone: f.phone || undefined,
      appointmentDate: ddmmyyyyToIso(meta.date),
      formLocation: meta.formLocation || undefined,
      extensionDays: meta.extensionDays ? Number(meta.extensionDays) : undefined,
      extensionReason: meta.extensionReason || undefined,
    };
    const body = new FormData();
    body.append("payload", JSON.stringify(payload));
    const tm30 = p.files.find((x) => x.kind === "tm30" && x.mime === "application/pdf");
    if (tm30) body.append("tm30", new File([tm30.blob], "tm30.pdf", { type: "application/pdf" }));
    const res = await fetch("/api/generate-tm7", { method: "POST", body });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    return res.blob();
  }

  async function tm7One(p: Person, open = true) {
    setError("");
    try {
      const blob = await generateTm7(p);
      patchPerson(p.id, (x) => ({ ...x, tm7Pdf: blob }));
      if (open) window.open(URL.createObjectURL(blob), "_blank");
    } catch (e) {
      setError(`${personFolderName(p)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function tm7All() {
    const ready = people.filter((p) => p.fields.firstName && p.fields.lastName && p.fields.passportNo);
    if (!ready.length) { setError("ยังไม่มีคนที่ข้อมูลครบ (ชื่อ นามสกุล เลขพาสปอร์ต)"); return; }
    setWorking(true); setError("");
    const blobs: Blob[] = [];
    try {
      for (let i = 0; i < ready.length; i++) {
        setStatus(`กำลังทำ TM7 ${i + 1}/${ready.length} — ${personFolderName(ready[i])}`);
        const blob = await generateTm7(ready[i]);
        patchPerson(ready[i].id, (x) => ({ ...x, tm7Pdf: blob }));
        blobs.push(blob);
      }
      setStatus("กำลังรวม PDF…");
      const merged = await mergePdfs(blobs);
      downloadBlob(merged, `TM7-${meta.jobType}-${meta.date.replace(/\//g, "")}-${ready.length}คน.pdf`);
      setStatus(`TM7 ครบ ${ready.length} คน รวมเป็นไฟล์เดียวแล้ว`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function excelTm30() {
    const ready = people.filter((p) => p.fields.firstName && p.fields.passportNo);
    if (!ready.length) { setError("ยังไม่มีคนที่มีชื่อและเลขพาสปอร์ต"); return; }
    try {
      const blob = await buildTm30Excel(ready, plusDaysDdmmyyyy(10));
      downloadBlob(blob, `TM30_${meta.date.replace(/\//g, "")}_${ready.length}คน.xls`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function dayZip() {
    if (!people.length) return;
    setWorking(true); setStatus("กำลังสร้าง zip โฟลเดอร์…");
    try {
      const blob = await buildDayZip(people, meta);
      downloadBlob(blob, `${meta.date.replace(/\//g, "")}_${meta.jobType}.zip`);
      setStatus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }

  async function clearDay() {
    if (!window.confirm("ล้างรายการทั้งวันนี้? (ไฟล์ที่ยังไม่ได้ดาวน์โหลดจะหายไป)")) return;
    await clearAll();
    setPeople([]);
    updateMeta({ date: todayDdmmyyyy() });
    setStatus("");
  }

  // ---------- file moves ----------
  function moveFile(fromId: string, fileId: string, toId: string) {
    const from = peopleRef.current.find((p) => p.id === fromId);
    const to = peopleRef.current.find((p) => p.id === toId);
    if (!from || !to || fromId === toId) return;
    const f = from.files.find((x) => x.id === fileId);
    if (!f) return;
    upsertPerson({ ...from, files: from.files.filter((x) => x.id !== fileId) });
    upsertPerson({ ...to, files: [...to.files, f] });
  }

  // ---------- render ----------
  const collect = people.filter((p) => p.fields.pay === "collect");
  const collectSum = collect.reduce((s, p) => s + (Number(p.fields.amount) || 0), 0);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">งานวันนี้</h1>
          <p className="text-sm text-slate-600">โยนรูปจาก LINE ทั้งวันลงทีเดียว → ระบบแยกคน อ่านข้อมูล ทำฟอร์ม ทำ Excel TM30 และโฟลเดอร์ให้</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">วันที่ยื่น</span>
            <input value={meta.date} onChange={(e) => updateMeta({ date: formatDateMask(e.target.value) })} className={inputCls + " w-32"} placeholder="DD/MM/YYYY" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">หน้างาน (ชื่อโฟลเดอร์)</span>
            <input value={meta.jobType} onChange={(e) => updateMeta({ jobType: e.target.value.toUpperCase() })} className={inputCls + " w-24"} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">สถานที่ยื่น</span>
            <input value={meta.formLocation} onChange={(e) => updateMeta({ formLocation: e.target.value.toUpperCase() })} className={inputCls + " w-32"} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-slate-500">วันที่ขอต่อ</span>
            <input value={meta.extensionDays} onChange={(e) => updateMeta({ extensionDays: e.target.value })} className={inputCls + " w-16"} />
          </label>
        </div>
      </header>

      <DropZone onFiles={handleFiles} disabled={working} />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-slate-700">
          <span className="font-semibold">{people.length}</span> คน
          {collect.length > 0 && <span className="ml-3 rounded bg-yellow-100 px-2 py-0.5 text-yellow-900">ต้องเก็บ {collect.length} คน รวม {collectSum.toLocaleString()} บาท</span>}
          {status && <span className="ml-3 text-slate-500">{status}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => addEmptyPerson()} className={btnCls}>+ เพิ่มคนว่าง</button>
          <button onClick={excelTm30} disabled={working || !people.length} className={btnCls}>⬇ Excel TM30</button>
          <button onClick={tm7All} disabled={working || !people.length} className={btnPrimaryCls}>⬇ TM7 ทุกคน (PDF เดียว)</button>
          <button onClick={dayZip} disabled={working || !people.length} className={btnCls}>⬇ โฟลเดอร์วันนี้ (zip)</button>
          <button onClick={clearDay} disabled={working} className={btnDangerCls}>ล้างวัน</button>
        </div>
      </div>

      {error && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="mt-6 space-y-4">
        {loaded && people.length === 0 && (
          <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">ยังไม่มีลูกค้าวันนี้ — ลากรูปลงด้านบน</p>
        )}
        {people.map((p) => (
          <PersonCard
            key={p.id}
            person={p}
            people={people}
            meta={meta}
            onChange={(next) => upsertPerson(next)}
            onRemove={() => removePerson(p.id)}
            onTm7={() => tm7One(p)}
            onMoveFile={(fileId, toId) => moveFile(p.id, fileId, toId)}
            busy={working}
          />
        ))}
      </div>
    </div>
  );
}

// =============================================================
// Person card
// =============================================================

const KIND_LABEL: Record<DocType, string> = { passport: "พาสปอร์ต", stamp: "ตราเข้าเมือง", selfie: "เซลฟี่", tm30: "TM30", other: "อื่น ๆ" };

function PersonCard({
  person: p, people, meta, onChange, onRemove, onTm7, onMoveFile, busy,
}: {
  person: Person;
  people: Person[];
  meta: DayMeta;
  onChange: (p: Person) => void;
  onRemove: () => void;
  onTm7: () => void;
  onMoveFile: (fileId: string, toPersonId: string) => void;
  busy: boolean;
}) {
  const f = p.fields;
  function set<K extends keyof PersonFields>(key: K, value: PersonFields[K]) {
    onChange({ ...p, fields: { ...p.fields, [key]: value } });
  }
  function setFileKind(fileId: string, kind: DocType) {
    onChange({ ...p, files: p.files.map((x) => (x.id === fileId ? { ...x, kind } : x)) });
  }
  function removeFile(fileId: string) {
    onChange({ ...p, files: p.files.filter((x) => x.id !== fileId) });
  }

  // overstay: appointment date after "admitted until"
  const until = parseDdmmyyyy(f.admittedUntil);
  const appt = parseDdmmyyyy(meta.date);
  const overstayDays = until && appt ? daysBetween(until, appt) : 0;
  const fine = overstayDays > 0 ? overstayDays * OVERSTAY_FINE_PER_DAY : 0;
  const missing: string[] = [];
  if (!f.firstName || !f.lastName) missing.push("ชื่อ");
  if (!f.passportNo) missing.push("เลขพาสปอร์ต");
  if (!f.arrivalDate) missing.push("วันเข้าเมือง");
  if (!f.houseNo && !f.province) missing.push("ที่อยู่ (TM30)");
  const hasSelfie = p.files.some((x) => x.kind === "selfie");

  return (
    <section className={`rounded-2xl bg-white p-4 shadow-sm ring-1 ${fine ? "ring-red-300" : "ring-slate-200"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="rounded-lg bg-slate-900 px-2.5 py-1 text-sm font-bold text-white">{String(p.order).padStart(2, "0")}</span>
          <div>
            <div className="text-base font-semibold text-slate-900">
              {[f.lastName, f.firstName].filter(Boolean).join(" ") || <span className="text-slate-400">ยังไม่มีชื่อ</span>}
              {f.chineseName && <span className="ml-2 text-slate-600">{f.chineseName}</span>}
            </div>
            <div className="text-xs text-slate-500">
              {f.passportNo || "—"} · {f.nationality || "—"}
              {p.tm7Pdf && <span className="ml-2 rounded bg-emerald-100 px-1.5 text-emerald-800">TM7 แล้ว</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={onTm7} disabled={busy} className={btnCls}>TM7 PDF</button>
          <button onClick={() => { if (window.confirm("ลบคนนี้?")) onRemove(); }} className={btnDangerCls}>ลบ</button>
        </div>
      </div>

      {(fine > 0 || missing.length > 0 || !hasSelfie) && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {fine > 0 && (
            <span className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 font-semibold text-red-800">
              ⚠ OVERSTAY {overstayDays} วัน — ค่าปรับ {fine.toLocaleString()} บาท (อยู่ได้ถึง {f.admittedUntil}) แจ้งลูกค้าและเก็บเพิ่ม
            </span>
          )}
          {missing.length > 0 && <span className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-amber-800">ขาด: {missing.join(", ")}</span>}
          {!hasSelfie && <span className="rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1 text-slate-600">ไม่มีเซลฟี่ → ใช้รูปจากพาสปอร์ต</span>}
        </div>
      )}

      {/* files */}
      <div className="mt-3 flex flex-wrap gap-2">
        {p.files.map((d) => (
          <div key={d.id} className={`w-28 rounded-lg border p-1.5 text-[11px] ${d.status === "error" ? "border-red-300 bg-red-50" : "border-slate-200"}`}>
            <Thumb doc={d} />
            <select value={d.kind} onChange={(e) => setFileKind(d.id, e.target.value as DocType)} className="mt-1 w-full rounded border border-slate-200 px-1 py-0.5">
              {(Object.keys(KIND_LABEL) as DocType[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <div className="mt-1 flex gap-1">
              <select value="" onChange={(e) => { if (e.target.value) onMoveFile(d.id, e.target.value); }} className="w-full rounded border border-slate-200 px-1 py-0.5" title="ย้ายไปคนอื่น">
                <option value="">ย้าย…</option>
                {people.filter((x) => x.id !== p.id).map((x) => <option key={x.id} value={x.id}>{String(x.order).padStart(2, "0")} {x.fields.lastName}</option>)}
              </select>
              <button onClick={() => removeFile(d.id)} className="rounded border border-slate-200 px-1.5 text-slate-500 hover:bg-slate-50">✕</button>
            </div>
            {d.error && <div className="mt-1 text-red-700">{d.error}</div>}
          </div>
        ))}
      </div>

      {/* fields */}
      <div className="mt-4 grid gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
        <F label="คำนำหน้า"><select value={f.title} onChange={(e) => set("title", e.target.value as PersonFields["title"])} className={inputCls}><option>MR.</option><option>MRS.</option><option>MISS</option></select></F>
        <F label="ชื่อ (given)"><input value={f.firstName} onChange={(e) => set("firstName", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="นามสกุล"><input value={f.lastName} onChange={(e) => set("lastName", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="ชื่อจีน"><input value={f.chineseName} onChange={(e) => set("chineseName", e.target.value)} className={inputCls} /></F>
        <F label="สัญชาติ"><input value={f.nationality} onChange={(e) => set("nationality", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="เลขพาสปอร์ต"><input value={f.passportNo} onChange={(e) => set("passportNo", e.target.value.toUpperCase())} className={inputCls} /></F>

        <F label="วันเกิด"><DateIn value={f.dateOfBirth} onChange={(v) => set("dateOfBirth", v)} /></F>
        <F label="สถานที่เกิด"><input value={f.placeOfBirth} onChange={(e) => set("placeOfBirth", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="พาสปอร์ตออก"><DateIn value={f.passportIssueDate} onChange={(v) => set("passportIssueDate", v)} /></F>
        <F label="พาสปอร์ตหมด"><DateIn value={f.passportExpiryDate} onChange={(v) => set("passportExpiryDate", v)} /></F>
        <F label="ออกให้ที่"><input value={f.passportIssuedAt} onChange={(e) => set("passportIssuedAt", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="มาจากประเทศ"><input value={f.fromCountry} onChange={(e) => set("fromCountry", e.target.value.toUpperCase())} className={inputCls} /></F>

        <F label="วันเข้าเมือง" hi><DateIn value={f.arrivalDate} onChange={(v) => set("arrivalDate", v)} hi /></F>
        <F label="อยู่ได้ถึง (ตราน้ำเงิน)" hi><DateIn value={f.admittedUntil} onChange={(v) => set("admittedUntil", v)} hi /></F>
        <F label="ด่าน"><input value={f.portOfArrival} onChange={(e) => set("portOfArrival", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="โดย"><input value={f.arrivedBy} onChange={(e) => set("arrivedBy", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="ประเภทวีซ่า" wide><input value={f.visaType} onChange={(e) => set("visaType", e.target.value.toUpperCase())} className={inputCls} /></F>

        <F label="บ้านเลขที่"><input value={f.houseNo} onChange={(e) => set("houseNo", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="ถนน"><input value={f.road} onChange={(e) => set("road", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="แขวง/ตำบล"><input value={f.subDistrict} onChange={(e) => set("subDistrict", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="เขต/อำเภอ"><input value={f.district} onChange={(e) => set("district", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="จังหวัด"><input value={f.province} onChange={(e) => set("province", e.target.value.toUpperCase())} className={inputCls} /></F>
        <F label="รหัสไปรษณีย์"><input value={f.postalCode} onChange={(e) => set("postalCode", e.target.value)} className={inputCls} /></F>

        <F label="เอเจนซี่ / ผู้ส่ง"><input value={f.agent} onChange={(e) => set("agent", e.target.value)} className={inputCls} list="today-agents" /></F>
        <F label="การเงิน">
          <select value={f.pay} onChange={(e) => set("pay", e.target.value as PersonFields["pay"])} className={inputCls}>
            <option value="collect">เก็บเงิน</option><option value="paid">จ่ายแล้ว</option><option value="nocollect">ไม่เก็บ</option>
          </select>
        </F>
        <F label="บาท"><input value={f.amount} onChange={(e) => set("amount", e.target.value.replace(/[^\d]/g, ""))} className={inputCls} placeholder="4000" /></F>
        <F label="หมายเหตุ" wide><input value={f.note} onChange={(e) => set("note", e.target.value)} className={inputCls} /></F>
        <F label="โทร"><input value={f.phone} onChange={(e) => set("phone", e.target.value)} className={inputCls} /></F>
      </div>
      <datalist id="today-agents">
        {Array.from(new Set(people.map((x) => x.fields.agent).filter(Boolean))).map((a) => <option key={a} value={a} />)}
      </datalist>
    </section>
  );
}

function Thumb({ doc }: { doc: DocFile }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (doc.mime === "application/pdf") { setUrl(""); return; }
    const u = URL.createObjectURL(doc.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [doc.blob, doc.mime]);
  if (doc.mime === "application/pdf") {
    return <div className="flex h-20 items-center justify-center rounded bg-slate-100 text-xs font-semibold text-slate-600">PDF</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt={doc.name} className="h-20 w-full cursor-zoom-in rounded object-cover" onClick={() => window.open(url, "_blank")} /> : <div className="h-20 rounded bg-slate-100" />;
}

function DropZone({ onFiles, disabled }: { onFiles: (f: FileList | File[]) => void; disabled: boolean }) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) onFiles(files);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [onFiles]);
  return (
    <div
      onClick={() => !disabled && ref.current?.click()}
      onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) onFiles(e.dataTransfer.files); }}
      className={`cursor-pointer rounded-2xl border-2 border-dashed p-8 text-center transition-colors ${over ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-white"} ${disabled ? "opacity-60" : ""}`}
    >
      <p className="text-base font-semibold text-slate-800">ลากรูปทั้งวันลงที่นี่ — พาสปอร์ต ตราเข้าเมือง เซลฟี่ และ TM30 (PDF) ปนกันได้</p>
      <p className="mt-1 text-xs text-slate-500">ระบบจัดกลุ่มตามลำดับไฟล์: พาสปอร์ตใบใหม่ = คนใหม่ รูปถัดไปเป็นของคนนั้น · วางจากคลิปบอร์ดได้ (Ctrl+V)</p>
      <input ref={ref} type="file" multiple accept="image/*,.pdf" hidden onChange={(e) => { if (e.target.files) onFiles(e.target.files); e.target.value = ""; }} />
    </div>
  );
}

// ---------- small UI bits ----------

const inputCls = "w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30";
const inputHiCls = "w-full rounded-md border border-yellow-400 bg-yellow-50 px-2 py-1.5 text-sm font-semibold text-yellow-900 focus:outline-none";
const btnCls = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const btnPrimaryCls = "rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300";
const btnDangerCls = "rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50";

function F({ label, children, hi, wide }: { label: string; children: React.ReactNode; hi?: boolean; wide?: boolean }) {
  return (
    <label className={`block ${wide ? "sm:col-span-2" : ""}`}>
      <span className={`mb-0.5 block text-[11px] ${hi ? "font-semibold text-yellow-800" : "text-slate-500"}`}>{label}</span>
      {children}
    </label>
  );
}

function formatDateMask(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

function DateIn({ value, onChange, hi }: { value: string; onChange: (v: string) => void; hi?: boolean }) {
  return <input value={value} onChange={(e) => onChange(formatDateMask(e.target.value))} placeholder="DD/MM/YYYY" inputMode="numeric" maxLength={10} className={hi ? inputHiCls : inputCls} />;
}
