// Hand-written types for the vendored, browser-shimmed @synonymdev/pkarr 0.1.4
// (see scripts/build-pkarr.mjs). Declares only the surface src/lib/pkarr.ts uses.

/** Fetch + instantiate the wasm (browser). Must be awaited before using any class. */
export function initPkarr(wasmUrl: string): Promise<unknown>

export interface PkarrRecord {
  name: string
  ttl: number
  rdata: { type: string; value?: string }
}

export class Client {
  constructor(relays?: string[], timeoutMs?: number)
  publish(packet: SignedPacket, casTimestamp?: number | null): Promise<void>
  resolve(publicKeyStr: string): Promise<SignedPacket | undefined>
  resolveMostRecent(publicKeyStr: string): Promise<SignedPacket | undefined>
  static defaultRelays(): string[]
}

export class Keypair {
  constructor()
  static from_secret_key(secretKeyBytes: Uint8Array): Keypair
  public_key_string(): string
  public_key_bytes(): Uint8Array
  secret_key_bytes(): Uint8Array
}

export class SignedPacket {
  static builder(): SignedPacketBuilder
  static fromBytes(bytes: Uint8Array): SignedPacket
  readonly records: PkarrRecord[]
  readonly timestampMs: number
  readonly publicKeyString: string
  bytes(): Uint8Array
  compressedBytes(): Uint8Array
}

export class SignedPacketBuilder {
  addTxtRecord(name: string, text: string, ttl: number): void
  buildAndSign(keypair: Keypair): SignedPacket
  clear(): void
}

export class Utils {
  static formatRecordValue(rdata: unknown): string
  static defaultRelays(): string[]
  static validatePublicKey(publicKey: string): boolean
}
