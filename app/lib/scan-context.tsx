import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import type { VariantRow } from "./costcheck.server";
import type { ScanResponse } from "../routes/api.costs";

/**
 * POSTs to the app's JSON endpoint. Inside the Shopify admin, App Bridge
 * patches fetch to attach the session token, so the request is authenticated.
 */
export async function postCosts<T extends object>(body: object): Promise<T | { error: string }> {
  try {
    const response = await fetch("/api/costs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (json && typeof json === "object") return json as T | { error: string };
    return { error: `Request failed (${response.status})` };
  } catch {
    return { error: "Network error. Check your connection and try again." };
  }
}

type ScanState = {
  rows: VariantRow[];
  setRows: Dispatch<SetStateAction<VariantRow[]>>;
  hasScanned: boolean;
  scanning: boolean;
  scanError: string | null;
  scannedAt: Date | null;
  startScan: () => Promise<void>;
  stopScan: () => void;
};

const ScanContext = createContext<ScanState | null>(null);

/**
 * Holds the latest scan in browser memory only, so the CostCheck and
 * Dashboard pages share it. Nothing is persisted; a reload clears it.
 */
export function ScanProvider({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<Date | null>(null);
  const scanningRef = useRef(false);
  const stopRequested = useRef(false);

  // Fetches variants page by page (cursor pagination) until done or stopped.
  const startScan = useCallback(async () => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    stopRequested.current = false;
    setRows([]);
    setScanError(null);
    setScanning(true);
    setHasScanned(true);

    let cursor: string | null = null;
    do {
      const data: ScanResponse = await postCosts<ScanResponse>({ intent: "scan", cursor });
      if ("error" in data) {
        setScanError(data.error);
        break;
      }
      setRows((prev) => [...prev, ...data.rows]);
      cursor = data.hasNextPage ? data.endCursor : null;
    } while (cursor && !stopRequested.current);

    scanningRef.current = false;
    setScanning(false);
    setScannedAt(new Date());
  }, []);

  const stopScan = useCallback(() => {
    stopRequested.current = true;
  }, []);

  return (
    <ScanContext.Provider
      value={{ rows, setRows, hasScanned, scanning, scanError, scannedAt, startScan, stopScan }}
    >
      {children}
    </ScanContext.Provider>
  );
}

export function useScan() {
  const value = useContext(ScanContext);
  if (!value) throw new Error("useScan must be used inside ScanProvider");
  return value;
}
