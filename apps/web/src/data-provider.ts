export const LIVE_DATA_LABEL = "Live testnet data";
export const DEMO_DATA_LABEL = "Demo only";

export interface FrontendDataProvider<T, Kind extends "demo" | "live"> {
  readonly kind: Kind;
  readonly label: Kind extends "demo" ? typeof DEMO_DATA_LABEL : typeof LIVE_DATA_LABEL;
  readonly load: () => T;
}

export function createLiveDataProvider<T>(loader: () => T): FrontendDataProvider<T, "live"> {
  return Object.freeze({ kind: "live", label: LIVE_DATA_LABEL, load: loader });
}

export function createDemoDataProvider<T>(fixture: T): FrontendDataProvider<T, "demo"> {
  return Object.freeze({ kind: "demo", label: DEMO_DATA_LABEL, load: () => fixture });
}
