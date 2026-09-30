type ClientDaoField = bigint | string;

interface ClientDao {
  readonly c: ClientDaoField;
  readonly ar: ClientDaoField;
  readonly s: ClientDaoField;
  readonly u: ClientDaoField;
}

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

function uint64(value: unknown, name: string): bigint {
  if (typeof value !== "bigint" && typeof value !== "string") {
    throw new TypeError(`${name} must be an integer`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new TypeError(`${name} must be an integer`);
  }
  if (parsed < 0n || parsed > UINT64_MAX) throw new RangeError(`${name} must fit uint64`);
  return parsed;
}

function record(value: unknown): ClientDao {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("client DAO value must be a raw header or parsed fields");
  }
  const candidate = value as Partial<ClientDao>;
  for (const key of ["c", "ar", "s", "u"] as const) {
    if (candidate[key] === undefined) throw new TypeError("client DAO fields are incomplete");
  }
  return candidate as ClientDao;
}

function littleEndian(value: bigint): string {
  const bytes = Array.from({ length: 8 }, (_, index) =>
    Number((value >> BigInt(index * 8)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  );
  return bytes.join("");
}

function uint64FromLittleEndian(value: string): bigint {
  const bytes = value.match(/../g);
  if (bytes === null || bytes.length !== 8) throw new TypeError("DAO field must contain 8 bytes");
  return BigInt(`0x${bytes.toReversed().join("")}`);
}

export function clientDaoHex(value: unknown): `0x${string}` {
  if (typeof value === "string") {
    if (!/^0x[0-9a-f]{64}$/.test(value)) throw new TypeError("raw client DAO value is invalid");
    return value as `0x${string}`;
  }
  const dao = record(value);
  return `0x${littleEndian(uint64(dao.c, "DAO c"))}${littleEndian(
    uint64(dao.ar, "DAO ar"),
  )}${littleEndian(uint64(dao.s, "DAO s"))}${littleEndian(uint64(dao.u, "DAO u"))}`;
}

export function clientDaoAccumulatedRate(value: unknown): bigint {
  if (typeof value !== "string") return uint64(record(value).ar, "DAO ar");
  const raw = clientDaoHex(value);
  return uint64FromLittleEndian(raw.slice(18, 34));
}
