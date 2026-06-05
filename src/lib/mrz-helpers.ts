// =============================================================
// MRZ helpers — map ICAO codes to demonyms and reformat dates
// =============================================================

// Common ICAO 3-letter codes → form demonym (uppercase).
// Falls back to the raw code if a country is not listed.
export const ICAO_TO_DEMONYM: Record<string, string> = {
  CHN: "CHINESE",
  TWN: "TAIWANESE",
  HKG: "HONG KONG",
  MAC: "MACANESE",
  JPN: "JAPANESE",
  KOR: "SOUTH KOREAN",
  PRK: "NORTH KOREAN",
  THA: "THAI",
  VNM: "VIETNAMESE",
  IDN: "INDONESIAN",
  MYS: "MALAYSIAN",
  SGP: "SINGAPOREAN",
  PHL: "FILIPINO",
  IND: "INDIAN",
  PAK: "PAKISTANI",
  BGD: "BANGLADESHI",
  LKA: "SRI LANKAN",
  NPL: "NEPALI",
  MMR: "BURMESE",
  KHM: "CAMBODIAN",
  LAO: "LAOTIAN",
  USA: "AMERICAN",
  CAN: "CANADIAN",
  MEX: "MEXICAN",
  BRA: "BRAZILIAN",
  ARG: "ARGENTINIAN",
  CHL: "CHILEAN",
  GBR: "BRITISH",
  IRL: "IRISH",
  FRA: "FRENCH",
  DEU: "GERMAN",
  ITA: "ITALIAN",
  ESP: "SPANISH",
  PRT: "PORTUGUESE",
  NLD: "DUTCH",
  BEL: "BELGIAN",
  CHE: "SWISS",
  AUT: "AUSTRIAN",
  SWE: "SWEDISH",
  NOR: "NORWEGIAN",
  DNK: "DANISH",
  FIN: "FINNISH",
  POL: "POLISH",
  CZE: "CZECH",
  HUN: "HUNGARIAN",
  ROU: "ROMANIAN",
  GRC: "GREEK",
  TUR: "TURKISH",
  RUS: "RUSSIAN",
  UKR: "UKRAINIAN",
  AUS: "AUSTRALIAN",
  NZL: "NEW ZEALANDER",
  ZAF: "SOUTH AFRICAN",
  EGY: "EGYPTIAN",
  ARE: "EMIRATI",
  SAU: "SAUDI",
  ISR: "ISRAELI",
  IRN: "IRANIAN",
};

export function icaoToDemonym(code: string | undefined): string {
  if (!code) return "";
  const upper = code.toUpperCase();
  return ICAO_TO_DEMONYM[upper] ?? upper;
}

// Convert MRZ "YYMMDD" to "DD/MM/YYYY".
// For birth dates we assume YY in the past; for expiry dates we assume future.
export function yymmddToDdmmyyyy(
  yymmdd: string | undefined,
  opts: { futureBias?: boolean } = {}
): string {
  if (!yymmdd || !/^\d{6}$/.test(yymmdd)) return "";
  const yy = Number(yymmdd.slice(0, 2));
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);

  let year: number;
  if (opts.futureBias) {
    year = 2000 + yy;
  } else {
    const currentYY = new Date().getFullYear() % 100;
    year = yy > currentYY ? 1900 + yy : 2000 + yy;
  }
  return `${dd}/${mm}/${year}`;
}

// MRZ names use "<" as separator and pad with "<". Strip + tidy.
export function cleanMrzName(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/</g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}
