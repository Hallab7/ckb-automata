export const LIVE_DATA_LABEL = "Live testnet data";
export const DEMO_DATA_LABEL = "Demo data";

const providerScope: unique symbol = Symbol("frontend-data-provider-scope");

export interface FrontendDataProvider<T, Kind extends "demo" | "live"> {
  readonly [providerScope]: Kind;
  readonly kind: Kind;
  readonly label: Kind extends "demo" ? typeof DEMO_DATA_LABEL : typeof LIVE_DATA_LABEL;
  readonly load: () => T;
}

export type DemoDataProvider<T> = FrontendDataProvider<T, "demo">;
export type LiveDataProvider<T> = FrontendDataProvider<T, "live">;

export function createLiveDataProvider<T>(loader: () => T): LiveDataProvider<T> {
  const provider: LiveDataProvider<T> = {
    [providerScope]: "live",
    kind: "live",
    label: LIVE_DATA_LABEL,
    load: loader,
  };
  return Object.freeze(provider);
}

export function createDemoDataProvider<T>(fixture: T): DemoDataProvider<T> {
  const provider: DemoDataProvider<T> = {
    [providerScope]: "demo",
    kind: "demo",
    label: DEMO_DATA_LABEL,
    load: () => fixture,
  };
  return Object.freeze(provider);
}
